import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELD_OUT_SPLIT_SCHEMA, requestSha256 } from "@mars/datasets";
import {
  createVllmServingAttestor,
  startFakeVllm,
  VllmClient,
  type VllmServingProfile,
} from "@mars/providers-vllm";
import {
  createFileArtifactStore,
  createSpecialistRegistry,
} from "@mars/specialists";
import {
  artifactRef,
  baseModel,
  context,
  EVIDENCE_SECRET,
  evidenceVerifier,
  fakeCatalog,
  fakeModel,
  MemoryArtifacts,
  makeBaseline,
  makeLineageArtifact,
  makeSpecialistFixture,
  tokenizer,
} from "../../../packages/specialists/tests/helpers";
import { runSpecialistsEvaluate } from "./specialists-eval";

test("remote serving is refused before sending the model key", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-eval-transport-"));
  const file = join(root, "heldout.json");
  await writeFile(
    file,
    JSON.stringify({
      schema: HELD_OUT_SPLIT_SCHEMA,
      split_id: "transport",
      tasks: [
        {
          task_id: "heldout",
          domain: "coding/edit",
          role: "worker",
          complexity: "medium",
          request: "question",
        },
      ],
    }),
  );
  const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ data: [] }),
  );
  try {
    for (const serving of [
      "http://remote.example",
      "https://remote.example",
      "http://user:password@127.0.0.1:8000",
      "http://127.0.0.1:8000/private?query=1",
    ]) {
      await expect(
        runSpecialistsEvaluate(
          [
            "--specialist",
            "s@1",
            "--held-out",
            file,
            "--model-key-env",
            "MODEL_KEY",
            "--serving",
            serving,
          ],
          { env: { MODEL_KEY: "test-only" } },
        ),
      ).rejects.toMatchObject({ code: "serving_missing" });
    }
    expect(
      fetcher.mock.calls.filter(([, init]) =>
        new Headers(init?.headers).has("authorization"),
      ),
    ).toHaveLength(0);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    fetcher.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

async function setup(
  mode: "improved" | "no_improvement" | "leakage" | "not_served",
) {
  const root = await mkdtemp(join(tmpdir(), "mars-live-eval-"));
  const adapter = artifactRef("adapter");
  const template = artifactRef("template");
  const profile: VllmServingProfile = {
    schema_version: 1,
    served_model_name: "mars-base",
    model_path: "/models/mars-base",
    base_model: baseModel,
    tokenizer,
    chat_template_sha256: template.sha256,
    capabilities: { tools: true, vision: false },
    max_lora_rank: 16,
  };
  const server = startFakeVllm({
    apiKey: "test-only",
    adapters: { [adapter.sha256]: "/adapter" },
    completions: (body) =>
      mode === "improved" &&
      (body as { model: string }).model === adapter.sha256
        ? "correct"
        : "wrong",
  });
  const registryDir = join(root, "registry");
  const artifacts = createFileArtifactStore(join(registryDir, "artifacts"));
  const memory = new MemoryArtifacts();
  const lineage = await makeLineageArtifact(memory, context.scope, {
    synthetic: false,
    trainTaskIds: mode === "leakage" ? ["heldout"] : ["train"],
    requestSha256s: [requestSha256("training request")],
  });
  const fixture = await makeSpecialistFixture(memory, {
    synthetic: false,
    adapter,
    chatTemplate: template,
    datasetLineage: lineage,
    adapterFormat: "peft-lora",
    adapterSpec: {
      format: "peft-lora",
      base_model: baseModel,
      tokenizer,
      chat_template_sha256: template.sha256,
    },
    serving: [
      {
        model_id: `vllm/${adapter.sha256}`,
        provider_id: "vllm",
        provider_model: adapter.sha256,
        adapter_format: "peft-lora",
      },
    ],
  });
  for (const ref of [fixture.registration.evaluation, lineage])
    await artifacts.put(
      context,
      await memory.get(context, ref),
      ref.media_type,
    );
  const catalog = fakeCatalog({
    models: [
      fakeModel({
        id: "vllm/mars-base",
        providerId: "vllm",
        model: "mars-base",
      }),
      fakeModel({
        id: `vllm/${adapter.sha256}`,
        providerId: "vllm",
        model: adapter.sha256,
      }),
    ],
  });
  const registry = createSpecialistRegistry({
    rootDir: registryDir,
    artifacts,
    catalog,
    evidenceVerifier: evidenceVerifier(),
    servingAttestor: createVllmServingAttestor({
      client: new VllmClient({ url: server.url }),
      profile,
    }),
  });
  await registry.registerBaseline(
    context,
    makeBaseline(context.scope, {
      model_id: "vllm/mars-base",
      provider_id: "vllm",
      provider_model: "mars-base",
    }),
  );
  await registry.registerSpecialist(context, fixture.registration);
  registry.close();
  const files = {
    "profile.json": profile,
    "trust.json": {
      schema: "mars.specialist-trust/v1",
      authorities: [
        {
          key_id: "test-key",
          authority_id: "test",
          secret_env: "TEST_SIGNING_SECRET",
          owner_ids: [context.scope.owner_id],
          evaluator_ids: ["eval-1", "mars-serving-evaluator"],
        },
      ],
    },
    "heldout.json": {
      schema: HELD_OUT_SPLIT_SCHEMA,
      split_id: "live-split",
      tasks: [
        {
          task_id: "heldout",
          domain: "coding/mechanical-edit",
          role: "worker",
          complexity: "medium",
          request: "answer please",
        },
      ],
    },
    "expectations.json": {
      schema: "mars.held-out-expectations/v1",
      split_id: "live-split",
      tasks: {
        heldout: { must_include: ["correct"], must_not_include: ["wrong"] },
      },
    },
  };
  for (const [file, value] of Object.entries(files))
    await writeFile(join(root, file), JSON.stringify(value));
  await mkdir(join(root, "home"));
  const env = {
    PATH: process.env.PATH,
    HOME: join(root, "home"),
    MARS_HOME: join(root, "home"),
    TEST_MODEL_KEY: "test-only",
    TEST_SIGNING_SECRET: new TextDecoder().decode(EVIDENCE_SECRET),
  };
  const args = [
    "--specialist",
    "specialist-1@1",
    "--held-out",
    join(root, "heldout.json"),
    "--model-key-env",
    "TEST_MODEL_KEY",
    "--serving",
    server.url,
    "--registry",
    registryDir,
    "--trust",
    join(root, "trust.json"),
    "--signing-key-id",
    "test-key",
    "--vllm-profile",
    join(root, "profile.json"),
    "--expectations",
    join(root, "expectations.json"),
    "--owner",
    context.scope.owner_id,
    "--project",
    context.scope.project_id,
  ];
  if (mode === "not_served") server.state.adapters.clear();
  return { root, server, args, env, registryDir, artifacts, catalog };
}

for (const mode of [
  "improved",
  "no_improvement",
  "leakage",
  "not_served",
] as const) {
  test(`default serving evaluator: ${mode}`, async () => {
    const f = await setup(mode);
    try {
      let printed = "";
      if (mode === "leakage" || mode === "not_served") {
        await expect(
          runSpecialistsEvaluate(f.args, { env: f.env, write: () => {} }),
        ).rejects.toMatchObject({
          code:
            mode === "not_served"
              ? "candidate_not_served"
              : "evaluation_refused",
        });
        expect(f.server.modelRequests()).toHaveLength(0);
      } else {
        const verdict = await runSpecialistsEvaluate(f.args, {
          env: f.env,
          write: (text) => {
            printed += text;
          },
        });
        expect(verdict.outcome).toBe(mode);
        expect(JSON.parse(printed)).toMatchObject({
          simulated: false,
          model_requests: f.server.modelRequests().length,
        });
        expect(f.server.modelRequests().length).toBeGreaterThan(0);
        const registry = createSpecialistRegistry({
          rootDir: f.registryDir,
          artifacts: f.artifacts,
          catalog: f.catalog,
          evidenceVerifier: evidenceVerifier(),
        });
        try {
          expect(
            (await registry.evaluationVerdicts(context, "specialist-1", "1"))[0]
              ?.outcome,
          ).toBe(mode);
        } finally {
          registry.close();
        }
      }
    } finally {
      await f.server.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  }, 60_000);
}

test("profile base mismatch refuses before any completion", async () => {
  const f = await setup("improved");
  try {
    const file = join(f.root, "profile.json");
    const profile = JSON.parse(await readFile(file, "utf8"));
    profile.base_model.revision = "different-revision";
    await writeFile(file, JSON.stringify(profile));
    await expect(
      runSpecialistsEvaluate(f.args, { env: f.env, write: () => {} }),
    ).rejects.toMatchObject({ code: "profile_mismatch" });
    expect(f.server.modelRequests()).toHaveLength(0);
  } finally {
    await f.server.stop();
    await rm(f.root, { recursive: true, force: true });
  }
}, 60_000);

test("default serving evaluation refuses invalid trust, expectations and budgets without completions", async () => {
  const f = await setup("improved");
  try {
    await expect(
      runSpecialistsEvaluate(f.args, {
        env: { ...f.env, TEST_SIGNING_SECRET: "" },
      }),
    ).rejects.toMatchObject({ code: "trust_invalid" });
    await expect(
      runSpecialistsEvaluate([...f.args, "--max-tokens", "0"], { env: f.env }),
    ).rejects.toMatchObject({ code: "usage" });
    await writeFile(
      join(f.root, "expectations.json"),
      JSON.stringify({
        schema: "mars.held-out-expectations/v1",
        split_id: "live-split",
        tasks: {},
      }),
    );
    await expect(
      runSpecialistsEvaluate(f.args, { env: f.env }),
    ).rejects.toMatchObject({ code: "expectations_invalid" });
    expect(f.server.modelRequests()).toHaveLength(0);
  } finally {
    await f.server.stop();
    await rm(f.root, { recursive: true, force: true });
  }
}, 60_000);

test("mars specialists evaluate spawn runs live arms only against loopback serving", async () => {
  const f = await setup("improved");
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "main.ts"),
        "specialists",
        "evaluate",
        ...f.args,
      ],
      { env: f.env, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(exit).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      outcome: "improved",
      simulated: false,
      model_requests: f.server.modelRequests().length,
    });
    expect(f.server.modelRequests().length).toBeGreaterThan(0);
  } finally {
    await f.server.stop();
    await rm(f.root, { recursive: true, force: true });
  }
}, 60_000);
