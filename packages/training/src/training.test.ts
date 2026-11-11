import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ArtifactRef, Budget, RequestContext } from "@mars/contracts";
import {
  buildDataset,
  type DatasetSplit,
  findHeldOutLeakage,
  requestSha256,
} from "@mars/datasets";
import {
  createHmacEvidenceSigner,
  DatasetLineageSchema,
} from "@mars/specialists";
import {
  createRegistry,
  EVIDENCE_SECRET,
  MemoryArtifacts,
  makeBaseline,
  makeSpecialistFixture,
  context as specialistContext,
} from "../../specialists/tests/helpers";
import {
  AdapterBundleSchema,
  baseModelCached,
  canonicalBytes,
  createCommandWorkerLauncher,
  createFileJobStore,
  createMemoryArtifactStore,
  createTrainingService,
  datasetsFromDatasetManifest,
  PLUMBING_LIMITATION,
  sha256,
  TokenizerRefsSchema,
  type TrainingManifest,
  TrainingManifestSchema,
  TrainingRunReportSchema,
  type TrainingServiceOptions,
} from "../src/index";

const FAKE_WORKER = path.join(import.meta.dir, "..", "tests", "fake-worker.ts");
const FIXTURES = path.join(import.meta.dir, "..", "fixtures", "synthetic");
const REPO = "synthetic-org/tiny-test-lm";
const REVISION = "0123456789abcdef0123456789abcdef01234567";
const TEMPLATE = new TextEncoder().encode(
  "{% for m in messages %}{{ m.content }}{% endfor %}",
);
const roots: string[] = [];

const context: RequestContext = specialistContext;
const budget: Budget = {
  max_tokens: 1_000_000,
  max_usd: 0,
  max_duration_ms: 60_000,
  max_depth: 0,
  max_concurrency: 1,
};

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function newRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "mars-training-"));
  roots.push(root);
  return root;
}

/** Synthetic huggingface_hub cache layout with no real weights. */
async function fakeHfCache(root: string): Promise<string> {
  const cache = path.join(root, "hf");
  const snapshot = path.join(
    cache,
    `models--${REPO.replace("/", "--")}`,
    "snapshots",
    REVISION,
  );
  await mkdir(snapshot, { recursive: true });
  await writeFile(path.join(snapshot, "config.json"), "{}");
  await writeFile(path.join(snapshot, "model.safetensors"), "synthetic");
  await writeFile(path.join(snapshot, "tokenizer.json"), '{"synthetic":true}');
  await writeFile(path.join(snapshot, "tokenizer_config.json"), "{}");
  await writeFile(path.join(snapshot, "chat_template.jinja"), TEMPLATE);
  return cache;
}

async function fixtureBytes() {
  return {
    train: new Uint8Array(await readFile(path.join(FIXTURES, "train.jsonl"))),
    validation: new Uint8Array(
      await readFile(path.join(FIXTURES, "validation.jsonl")),
    ),
  };
}

function manifestFor(
  bytes: { train: Uint8Array; validation: Uint8Array },
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: "mars.training-manifest/v1",
    manifest_id: "synthetic-manifest",
    specialist_id: "specialist-1",
    base_model: { repo: REPO, revision: REVISION },
    tokenizer: { repo: REPO, revision: REVISION },
    chat_template: {
      repo: REPO,
      revision: REVISION,
      path: "chat_template.jinja",
      sha256: sha256(TEMPLATE),
    },
    datasets: [
      {
        dataset_id: "synthetic-train",
        split: "train",
        sha256: sha256(bytes.train),
        example_count: 9,
        task_ids: ["synthetic-task-1", "synthetic-task-2"],
      },
      {
        dataset_id: "synthetic-validation",
        split: "validation",
        sha256: sha256(bytes.validation),
        example_count: 3,
        task_ids: ["synthetic-task-3"],
      },
    ],
    heldout: { split_sha256: "a".repeat(64), task_ids: ["heldout-task-1"] },
    method: "lora",
    lora: { r: 4, alpha: 8, dropout: 0, target_modules: "all-linear" },
    sft: {
      max_steps: 2,
      learning_rate: 0.001,
      per_device_train_batch_size: 2,
      gradient_accumulation_steps: 1,
      max_length: 128,
      seed: 7,
    },
    generation: { max_new_tokens: 4 },
    provenance: { synthetic_fixture: true },
    ...overrides,
  };
}

async function setup(
  mode = "ok",
  overrides: Partial<TrainingServiceOptions> = {},
) {
  const root = await newRoot();
  const artifacts = createMemoryArtifactStore();
  const bytes = await fixtureBytes();
  await artifacts.put(context, bytes.train, "application/jsonl");
  await artifacts.put(context, bytes.validation, "application/jsonl");
  const service = createTrainingService({
    artifacts,
    workRoot: path.join(root, "work"),
    hfCacheDir: await fakeHfCache(root),
    launcher: createCommandWorkerLauncher(
      [process.execPath, FAKE_WORKER, mode],
      { id: `fake:${mode}` },
    ),
    lineageSigner: createHmacEvidenceSigner({
      key_id: "test-key",
      secret: EVIDENCE_SECRET,
    }),
    producerId: "trainer-1",
    killGraceMs: 200,
    ...overrides,
  });
  const putManifest = (manifest: Record<string, unknown>) =>
    artifacts.put(context, canonicalBytes(manifest), "application/json");
  return { root, artifacts, bytes, service, putManifest };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number, ms = 5000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await Bun.sleep(50);
  }
  return !alive(pid);
}

async function waitFor(file: string, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (existsSync(file)) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${file}`);
}

describe("mars.training-manifest/v1", () => {
  test("the checked-in synthetic fixture manifest parses and is marked synthetic", async () => {
    const manifest = TrainingManifestSchema.parse(
      JSON.parse(await readFile(path.join(FIXTURES, "manifest.json"), "utf8")),
    );
    const bytes = await fixtureBytes();
    expect(manifest.provenance.synthetic_fixture).toBe(true);
    expect(manifest.datasets.map((d) => d.sha256)).toEqual([
      sha256(bytes.train),
      sha256(bytes.validation),
    ]);
  });

  test("refuses unpinned base model, tokenizer and chat template revisions", async () => {
    const { service, bytes, putManifest } = await setup();
    const ref = await putManifest(
      manifestFor(bytes, {
        base_model: { repo: REPO, revision: "main" },
        tokenizer: { repo: REPO, revision: "v1.0" },
        chat_template: {
          repo: REPO,
          revision: "0123abc",
          path: "chat_template.jinja",
          sha256: sha256(TEMPLATE),
        },
      }),
    );
    const validation = await service.validate(context, ref);
    expect(validation.ready).toBe(false);
    expect(validation.missing).toEqual(
      expect.arrayContaining([
        "base_model_revision_not_pinned",
        "tokenizer_revision_not_pinned",
        "chat_template_revision_not_pinned",
      ]),
    );
    await expect(service.submit(context, ref, budget)).rejects.toMatchObject({
      code: "not_ready",
    });
  });

  test("refuses a chat template without a sha256 pin or with mismatching bytes", async () => {
    const { service, bytes, putManifest } = await setup();
    const unpinned = await putManifest(
      manifestFor(bytes, {
        chat_template: {
          repo: REPO,
          revision: REVISION,
          path: "chat_template.jinja",
        },
      }),
    );
    expect((await service.validate(context, unpinned)).missing).toContain(
      "chat_template_sha256_not_pinned",
    );
    const wrong = await putManifest(
      manifestFor(bytes, {
        chat_template: {
          repo: REPO,
          revision: REVISION,
          path: "chat_template.jinja",
          sha256: "f".repeat(64),
        },
      }),
    );
    expect((await service.validate(context, wrong)).missing).toContain(
      "chat_template_sha256_mismatch",
    );
  });
});

test("the recorded CPU-run evidence parses with the current schemas", async () => {
  const evidence = JSON.parse(
    await readFile(
      path.join(
        import.meta.dir,
        "..",
        "..",
        "..",
        "documentation",
        "evidence",
        "training-tiny-cpu-run.json",
      ),
      "utf8",
    ),
  );
  const report = TrainingRunReportSchema.parse(evidence.report);
  expect(report.limitations).toEqual([PLUMBING_LIMITATION]);
  expect(report.synthetic_fixture).toBe(true);
  AdapterBundleSchema.parse(evidence.bundle);
  DatasetLineageSchema.parse(evidence.lineage);
  TrainingManifestSchema.parse(
    JSON.parse(await readFile(path.join(FIXTURES, "manifest.json"), "utf8")),
  );
});

describe("dataset and leakage checks", () => {
  test("refuses when dataset bytes do not match the manifest sha256", async () => {
    const tampered = new TextEncoder().encode(
      '{"messages":[{"role":"user","content":"x"},{"role":"assistant","content":"y"}]}\n',
    );
    const { service, bytes, putManifest } = await setup("ok", {
      resolveDataset: async (_context, dataset) =>
        dataset.split === "train"
          ? tampered
          : (await fixtureBytes()).validation,
    });
    const ref = await putManifest(manifestFor(bytes));
    const validation = await service.validate(context, ref);
    expect(validation.missing).toContain(
      "dataset_sha256_mismatch:synthetic-train",
    );
    await expect(service.submit(context, ref, budget)).rejects.toMatchObject({
      code: "not_ready",
    });
  });

  test("refuses missing, malformed and miscounted datasets", async () => {
    const { service, artifacts, bytes, putManifest } = await setup();
    const malformed = new TextEncoder().encode(
      '{"messages":[{"role":"tool","content":"x"}]}\n',
    );
    await artifacts.put(context, malformed, "application/jsonl");
    const manifest = manifestFor(bytes) as {
      datasets: Array<Record<string, unknown>>;
    };
    manifest.datasets[0] = {
      ...manifest.datasets[0],
      sha256: sha256(malformed),
      example_count: 1,
    };
    manifest.datasets[1] = { ...manifest.datasets[1], example_count: 4 };
    const missing = (
      await service.validate(context, await putManifest(manifest))
    ).missing;
    expect(missing).toContain("dataset_malformed:synthetic-train:1");
    expect(missing).toContain(
      "dataset_example_count_mismatch:synthetic-validation",
    );
    manifest.datasets[0] = { ...manifest.datasets[0], sha256: "e".repeat(64) };
    expect(
      (await service.validate(context, await putManifest(manifest))).missing,
    ).toContain("dataset_missing:synthetic-train");
  });

  test("detects train/validation and held-out leakage before training", async () => {
    const { service, bytes, putManifest } = await setup();
    const manifest = manifestFor(bytes, {
      heldout: {
        split_sha256: sha256(bytes.validation),
        task_ids: ["synthetic-task-1"],
      },
    }) as { datasets: Array<Record<string, unknown>> };
    manifest.datasets[1] = {
      ...manifest.datasets[1],
      task_ids: ["synthetic-task-2"],
    };
    const missing = (
      await service.validate(context, await putManifest(manifest))
    ).missing;
    expect(missing).toEqual(
      expect.arrayContaining([
        "leakage:train_validation_task_overlap",
        "leakage:heldout_task_overlap",
        "leakage:heldout_split_reused",
      ]),
    );
    const duplicated = manifestFor(bytes) as {
      datasets: Array<Record<string, unknown>>;
    };
    duplicated.datasets[1] = {
      ...duplicated.datasets[1],
      sha256: sha256(bytes.train),
      example_count: 9,
    };
    expect(
      (await service.validate(context, await putManifest(duplicated))).missing,
    ).toEqual(
      expect.arrayContaining([
        "leakage:train_validation_identical",
        "leakage:train_validation_example_overlap",
      ]),
    );
  });
});

describe("hardware, pins and QLoRA", () => {
  test("a sharded base model is cached only when every indexed shard is present", async () => {
    const root = await newRoot();
    const cache = await fakeHfCache(root);
    const snapshot = path.join(
      cache,
      `models--${REPO.replace("/", "--")}`,
      "snapshots",
      REVISION,
    );
    await rm(path.join(snapshot, "model.safetensors"));
    const index = {
      weight_map: {
        "a.weight": "model-00001-of-00002.safetensors",
        "b.weight": "model-00002-of-00002.safetensors",
      },
    };
    await writeFile(
      path.join(snapshot, "model.safetensors.index.json"),
      JSON.stringify(index),
    );
    await writeFile(
      path.join(snapshot, "model-00001-of-00002.safetensors"),
      "x",
    );
    const ref = { repo: REPO, revision: REVISION };
    expect(await baseModelCached(cache, ref)).toBe(false);
    await writeFile(
      path.join(snapshot, "model-00002-of-00002.safetensors"),
      "x",
    );
    expect(await baseModelCached(cache, ref)).toBe(true);
    await writeFile(
      path.join(snapshot, "model.safetensors.index.json"),
      JSON.stringify({ weight_map: { a: "../../x.safetensors" } }),
    );
    expect(await baseModelCached(cache, ref)).toBe(false);
  });

  test("estimate is honest on CPU: no dollar figure, LoRA only, QLoRA unavailable", async () => {
    const { service, bytes, putManifest } = await setup();
    const lora = await service.estimate(
      context,
      await putManifest(manifestFor(bytes)),
    );
    expect(lora).toEqual({
      estimated_usd: null,
      hardware: ["cpu:8-logical-cores", "method:lora-fp32", "token_bound:1412"],
    });
    const qloraRef = await putManifest(manifestFor(bytes, { method: "qlora" }));
    expect((await service.estimate(context, qloraRef)).hardware).toContain(
      "method:qlora-unavailable(no-cuda-or-bitsandbytes)",
    );
    const missing = (await service.validate(context, qloraRef)).missing;
    expect(missing).toEqual([
      "qlora_requires_cuda",
      "qlora_requires_bitsandbytes",
    ]);
  });

  test("QLoRA is allowed only when the worker reports CUDA and bitsandbytes", async () => {
    const { service, bytes, putManifest } = await setup("cuda");
    const ref = await putManifest(manifestFor(bytes, { method: "qlora" }));
    expect(await service.validate(context, ref)).toEqual({
      ready: true,
      missing: [],
    });
    expect((await service.estimate(context, ref)).hardware).toEqual([
      "cuda:Synthetic GPU",
      "method:qlora-4bit-nf4",
      "token_bound:1412",
    ]);
  });

  test("refuses a worker venv whose versions drift from the pins", async () => {
    const { service, bytes, putManifest } = await setup("stale-pins");
    expect(
      (await service.validate(context, await putManifest(manifestFor(bytes))))
        .missing,
    ).toEqual(["worker_pin_mismatch:torch"]);
  });

  test("refuses uncached base model and tokenizer revisions", async () => {
    const { service, bytes, putManifest } = await setup();
    const other = "fedcba9876543210fedcba9876543210fedcba98";
    const missing = (
      await service.validate(
        context,
        await putManifest(
          manifestFor(bytes, {
            base_model: { repo: REPO, revision: other },
            tokenizer: { repo: REPO, revision: other },
          }),
        ),
      )
    ).missing;
    expect(missing).toEqual(["base_model_not_cached", "tokenizer_not_cached"]);
  });

  test("refuses budgets whose token bound is too small", async () => {
    const { service, bytes, putManifest } = await setup();
    const ref = await putManifest(manifestFor(bytes));
    await expect(
      service.submit(context, ref, { ...budget, max_tokens: 100 }),
    ).rejects.toMatchObject({
      code: "not_ready",
      detail: "budget_tokens_exceeded",
    });
  });
});

describe("training job lifecycle (fake worker)", () => {
  test("completes with hash-addressed adapter artifacts and a signed lineage record", async () => {
    const { service, artifacts, bytes, putManifest } = await setup();
    const manifestRef = await putManifest(manifestFor(bytes));
    expect(await service.validate(context, manifestRef)).toEqual({
      ready: true,
      missing: [],
    });
    const job = await service.submit(context, manifestRef, budget);
    expect(job.input_manifest).toEqual(manifestRef);
    const result = await service.wait(context, job.job_id);
    expect(result.status).toBe("completed");
    expect(result.cost_usd).toBeNull();
    expect(result.artifacts).toHaveLength(7);
    for (const ref of result.artifacts) {
      expect(ref.artifact_id).toBe(`art-${ref.sha256.slice(0, 32)}`);
      expect(sha256(await artifacts.get(context, ref))).toBe(ref.sha256);
    }
    const record = await service.inspectRecord(context, job.job_id);
    expect(record.progress).toEqual({ step: 2, loss: 2.25 });
    if (!record.report) throw new Error("report missing");
    const report = TrainingRunReportSchema.parse(
      JSON.parse(
        new TextDecoder().decode(await artifacts.get(context, record.report)),
      ),
    );
    expect(report.limitations).toEqual([PLUMBING_LIMITATION]);
    expect(report.synthetic_fixture).toBe(true);
    const bundle = AdapterBundleSchema.parse(
      JSON.parse(
        new TextDecoder().decode(
          await artifacts.get(context, report.artifacts.adapter_bundle),
        ),
      ),
    );
    expect(bundle.base_model).toEqual({
      component: `hf:${REPO}`,
      revision: REVISION,
    });
    expect(bundle.chat_template_sha256).toBe(sha256(TEMPLATE));
    expect(bundle.weights.media_type).toBe(
      "application/vnd.mars.peft-adapter-weights+safetensors",
    );
    const tokenizerRefs = TokenizerRefsSchema.parse(
      JSON.parse(
        new TextDecoder().decode(
          await artifacts.get(context, bundle.tokenizer_refs),
        ),
      ),
    );
    expect(tokenizerRefs.files["tokenizer.json"]).toBe(
      sha256('{"synthetic":true}'),
    );
    const lineage = DatasetLineageSchema.parse(
      JSON.parse(
        new TextDecoder().decode(
          await artifacts.get(context, report.artifacts.dataset_lineage),
        ),
      ),
    );
    expect(lineage.datasets).toEqual([
      {
        dataset_id: "synthetic-train",
        sha256: sha256(bytes.train),
        split: "train",
      },
      {
        dataset_id: "synthetic-validation",
        sha256: sha256(bytes.validation),
        split: "validation",
      },
    ]);
    expect(lineage.train_task_ids).toEqual([
      "synthetic-task-1",
      "synthetic-task-2",
    ]);
    expect(lineage.training.job_id).toBe(job.job_id);
    expect(lineage.provenance.synthetic_fixture).toBe(true);
    expect(lineage.attestation.key_id).toBe("test-key");
    const userTurns = [bytes.train, bytes.validation].flatMap((file) =>
      new TextDecoder()
        .decode(file)
        .trim()
        .split("\n")
        .flatMap(
          (line) =>
            (
              JSON.parse(line) as {
                messages: { role: string; content: string }[];
              }
            ).messages,
        )
        .filter((message) => message.role === "user")
        .map((message) => message.content),
    );
    expect(userTurns.length).toBeGreaterThan(0);
    expect(lineage.request_sha256s).toEqual(
      [...new Set(userTurns.map(requestSha256))].sort(),
    );
    // A held-out task restating a training request under another task id is
    // caught by the lineage digests alone.
    expect(
      findHeldOutLeakage(
        {
          schema: "mars.held-out-split/v1",
          split_id: "heldout",
          tasks: [
            {
              task_id: "heldout-task-1",
              domain: "code/typescript",
              role: "worker",
              complexity: "light",
              request: `  ${userTurns[0]?.toUpperCase()}  `,
            },
          ],
        },
        {
          task_ids: [...lineage.train_task_ids, ...lineage.validation_task_ids],
          request_sha256s: lineage.request_sha256s ?? [],
        },
      ),
    ).toEqual([{ task_id: "heldout-task-1", reason: "training-request" }]);
  });

  test("the @mars/specialists registry accepts the adapter and lineage, and flags leakage", async () => {
    async function trainAndRegister(
      manifestOverrides: Record<string, unknown>,
      specialistId: string,
    ) {
      const { service, artifacts, bytes, putManifest } = await setup();
      const job = await service.submit(
        context,
        await putManifest(
          manifestFor(bytes, {
            specialist_id: specialistId,
            ...manifestOverrides,
          }),
        ),
        budget,
      );
      expect((await service.wait(context, job.job_id)).status).toBe(
        "completed",
      );
      const record = await service.inspectRecord(context, job.job_id);
      if (!record.report) throw new Error("report missing");
      const report = TrainingRunReportSchema.parse(
        JSON.parse(
          new TextDecoder().decode(await artifacts.get(context, record.report)),
        ),
      );
      const loader = new MemoryArtifacts();
      for (const ref of record.artifacts)
        loader.set(ref, await artifacts.get(context, ref));
      const registry = createRegistry(await newRoot(), loader);
      await registry.registerBaseline(context, makeBaseline());
      const fixture = await makeSpecialistFixture(loader, {
        specialistId,
        baseModel: report.registration.base_model,
        tokenizer: report.registration.tokenizer,
        chatTemplate: report.registration.chat_template,
        adapter: report.registration.adapter,
        datasetLineage: report.registration.dataset_lineage,
        adapterSpec: report.registration.adapter_spec,
        adapterFormat: "peft-lora",
      });
      return registry.registerSpecialist(context, fixture.registration);
    }
    const accepted = await trainAndRegister({}, "trained-specialist");
    expect(
      accepted.verdict.codes.filter((code: string) =>
        code.startsWith("lineage"),
      ),
    ).toEqual([]);
    expect(accepted.verdict.codes).not.toContain("evidence_subject_mismatch");
    // Held-out ids the trainer was not told about still reach the registry, which rejects the leak.
    const leaked = await trainAndRegister(
      {
        heldout: null,
        datasets: (
          manifestFor(await fixtureBytes()).datasets as Array<
            Record<string, unknown>
          >
        ).map((d) =>
          d.split === "train" ? { ...d, task_ids: ["heldout-task-1"] } : d,
        ),
      },
      "leaky-specialist",
    );
    expect(leaked.verdict.codes).toContain("lineage_leakage");
  });

  test("worker errors, protocol garbage and mismatched adapter configs fail the job", async () => {
    for (const [mode, code] of [
      ["error", "worker_error"],
      ["garbage", "worker_protocol"],
      ["bad-config", "worker_protocol"],
    ] as const) {
      const { service, bytes, putManifest } = await setup(mode);
      const job = await service.submit(
        context,
        await putManifest(manifestFor(bytes)),
        budget,
      );
      expect((await service.wait(context, job.job_id)).status).toBe("failed");
      const record = await service.inspectRecord(context, job.job_id);
      expect(record.error?.code).toBe(code);
      expect(record.artifacts).toEqual([]);
    }
  });

  test("cancel kills the whole worker process group", async () => {
    const { root, service, bytes, putManifest } = await setup("hang");
    const job = await service.submit(
      context,
      await putManifest(manifestFor(bytes)),
      budget,
    );
    const pidFile = path.join(root, "work", `${job.job_id}.pids.json`);
    await waitFor(pidFile);
    const pids = JSON.parse(await readFile(pidFile, "utf8")) as {
      worker: number;
      grandchild: number;
    };
    expect(alive(pids.grandchild)).toBe(true);
    await expect(
      service.submit(context, await putManifest(manifestFor(bytes)), budget),
    ).rejects.toMatchObject({
      code: "capacity_exhausted",
    });
    await service.cancel(context, job.job_id);
    expect((await service.inspect(context, job.job_id)).status).toBe(
      "cancelled",
    );
    expect(await waitDead(pids.worker)).toBe(true);
    expect(await waitDead(pids.grandchild)).toBe(true);
    expect(existsSync(path.join(root, "work", job.job_id))).toBe(false);
  });

  test("the wall-clock deadline kills the whole worker process group", async () => {
    const { root, service, bytes, putManifest } = await setup("hang");
    const job = await service.submit(
      context,
      await putManifest(manifestFor(bytes)),
      {
        ...budget,
        max_duration_ms: 1500,
      },
    );
    const pidFile = path.join(root, "work", `${job.job_id}.pids.json`);
    await waitFor(pidFile);
    const pids = JSON.parse(await readFile(pidFile, "utf8")) as {
      worker: number;
      grandchild: number;
    };
    const result = await service.wait(context, job.job_id);
    expect(result.status).toBe("failed");
    expect((await service.inspectRecord(context, job.job_id)).error?.code).toBe(
      "deadline_exceeded",
    );
    expect(await waitDead(pids.worker)).toBe(true);
    expect(await waitDead(pids.grandchild)).toBe(true);
  });

  test("a worker that closes stdout but keeps running is still stopped by the deadline", async () => {
    const { service, bytes, putManifest } = await setup("close-stdout");
    const job = await service.submit(
      context,
      await putManifest(manifestFor(bytes)),
      {
        ...budget,
        max_duration_ms: 1000,
      },
    );
    expect((await service.wait(context, job.job_id)).status).toBe("failed");
    expect((await service.inspectRecord(context, job.job_id)).error?.code).toBe(
      "deadline_exceeded",
    );
  });

  test("jobs left running by a previous host process are reported as interrupted", async () => {
    const root = await newRoot();
    const jobs = createFileJobStore(path.join(root, "jobs"));
    const first = await setup("hang", { jobs });
    const job = await first.service.submit(
      context,
      await first.putManifest(manifestFor(first.bytes)),
      budget,
    );
    await waitFor(path.join(first.root, "work", `${job.job_id}.pids.json`));
    const second = await setup("ok", { jobs });
    const result = await second.service.inspect(context, job.job_id);
    expect(result.status).toBe("failed");
    expect(
      (await second.service.inspectRecord(context, job.job_id)).error?.code,
    ).toBe("interrupted");
    await first.service.cancel(context, job.job_id);
  });

  test("unknown jobs and foreign scopes are not found", async () => {
    const { service, bytes, putManifest } = await setup();
    const job = await service.submit(
      context,
      await putManifest(manifestFor(bytes)),
      budget,
    );
    await service.wait(context, job.job_id);
    const foreign: RequestContext = {
      ...context,
      scope: { owner_id: "owner-2", project_id: "project-2" },
    };
    await expect(service.inspect(foreign, job.job_id)).rejects.toMatchObject({
      code: "job_not_found",
    });
    await expect(
      service.inspect(context, "train-missing"),
    ).rejects.toMatchObject({ code: "job_not_found" });
    const missingManifest: ArtifactRef = {
      ...job.input_manifest,
      sha256: "0".repeat(64),
    };
    expect((await service.validate(context, missingManifest)).missing).toEqual([
      "manifest_missing",
    ]);
  });
});

describe("consumes @mars/datasets output", () => {
  function built() {
    const examples = "abcdefghij".split("").map((id) => {
      const patch = `--- a/${id}.ts\n+++ b/${id}.ts\n@@ -1 +1 @@\n-bad\n+good\n`;
      return {
        task_id: `task-${id}`,
        scope: context.scope,
        request: `Fix ${id}`,
        patch,
        patch_sha256: sha256(patch),
        verdict_run_id: `run-${id}`,
        check_manifest_sha256: null,
      };
    });
    return buildDataset({
      dataset_id: "synthetic-built",
      examples,
      held_out: [{ source: "heldout", task_ids: ["heldout-task-1"] }],
      private_patterns: ["/home/private"],
      validation_fraction: 0.3,
    });
  }

  async function setupBuilt(overrides: Partial<TrainingServiceOptions> = {}) {
    const dataset = built();
    const env = await setup("ok", overrides);
    await env.artifacts.put(context, dataset.files.train, "application/jsonl");
    await env.artifacts.put(
      context,
      dataset.files.validation,
      "application/jsonl",
    );
    const datasetManifest = await env.artifacts.put(
      context,
      new TextEncoder().encode(JSON.stringify(dataset.manifest)),
      "application/json",
    );
    const manifest = manifestFor(env.bytes, {
      datasets: datasetsFromDatasetManifest(dataset.manifest),
      dataset_manifest: {
        dataset_id: dataset.manifest.dataset_id,
        sha256: datasetManifest.sha256,
      },
    });
    return { ...env, dataset, datasetManifest, manifest };
  }

  test("split entries are used as-is and training completes", async () => {
    const splitType: DatasetSplit[] = built().manifest.splits;
    expect(splitType).toHaveLength(2);
    const {
      service,
      artifacts,
      dataset,
      datasetManifest,
      manifest,
      putManifest,
    } = await setupBuilt();
    const ref = await putManifest(manifest);
    expect(await service.validate(context, ref)).toEqual({
      ready: true,
      missing: [],
    });
    const job = await service.submit(context, ref, budget);
    expect((await service.wait(context, job.job_id)).status).toBe("completed");
    const record = await service.inspectRecord(context, job.job_id);
    if (!record.report) throw new Error("report missing");
    const report = TrainingRunReportSchema.parse(
      JSON.parse(
        new TextDecoder().decode(await artifacts.get(context, record.report)),
      ),
    );
    expect(report.dataset_manifest_sha256).toBe(datasetManifest.sha256);
    const lineage = DatasetLineageSchema.parse(
      JSON.parse(
        new TextDecoder().decode(
          await artifacts.get(context, report.artifacts.dataset_lineage),
        ),
      ),
    );
    expect(lineage.datasets.map((d) => d.sha256)).toEqual(
      dataset.manifest.splits.map((s) => s.sha256),
    );
    expect(
      [...lineage.train_task_ids, ...lineage.validation_task_ids].sort(),
    ).toEqual(dataset.manifest.splits.flatMap((s) => s.task_ids).sort());
  });

  test("refuses a split whose file sha256 differs from the dataset manifest", async () => {
    const { service, manifest, putManifest } = await setupBuilt({
      resolveDataset: async (_context, dataset) =>
        dataset.split === "train"
          ? (await fixtureBytes()).train
          : built().files.validation,
    });
    const ref = await putManifest(manifest);
    expect((await service.validate(context, ref)).missing).toContain(
      "dataset_sha256_mismatch:synthetic-built-train",
    );
    await expect(service.submit(context, ref, budget)).rejects.toMatchObject({
      code: "not_ready",
    });
  });

  test("refuses split entries that drift from, or a pin that misses, the dataset manifest", async () => {
    const { service, manifest, putManifest } = await setupBuilt();
    const drifted = structuredClone(manifest) as {
      datasets: Array<{ task_ids: string[] }>;
    };
    drifted.datasets[0]?.task_ids.reverse();
    expect(
      (await service.validate(context, await putManifest(drifted))).missing,
    ).toEqual(["dataset_manifest_splits_mismatch"]);
    const unpinned = {
      ...manifest,
      dataset_manifest: {
        dataset_id: "synthetic-built",
        sha256: "d".repeat(64),
      },
    };
    expect(
      (await service.validate(context, await putManifest(unpinned))).missing,
    ).toEqual(["dataset_manifest_missing"]);
    const wrongId = {
      ...manifest,
      dataset_manifest: {
        ...(manifest.dataset_manifest as object),
        dataset_id: "other",
      },
    };
    expect(
      (await service.validate(context, await putManifest(wrongId))).missing,
    ).toEqual(["dataset_manifest_invalid"]);
  });
});

export type { TrainingManifest };
