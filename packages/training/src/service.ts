import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ArtifactRef,
  ArtifactRefSchema,
  type Budget,
  BudgetSchema,
  type JobRef,
  type JobResult,
  type RequestContext,
  type TrainingService,
  type VersionRef,
} from "@mars/contracts";
import { requestSha256 } from "@mars/datasets";
import { type DatasetLineage, DatasetLineageSchema } from "@mars/specialists";
import { canonicalBytes, canonicalJson, scopeKey, sha256 } from "./canonical";
import {
  checkDataset,
  checkLeakage,
  datasetFor,
  type ParsedDataset,
} from "./dataset";
import { TrainingError } from "./errors";
import {
  baseModelCached,
  readSnapshotFile,
  tokenizerFileDigests,
} from "./hf-cache";
import { defaultHfCacheDir, TRAINING_PINS } from "./pins";
import {
  ADAPTER_BUNDLE_SCHEMA,
  type AdapterBundle,
  ConversationalExampleSchema,
  DatasetManifestSplitsSchema,
  type JobRecord,
  type PinnedHfRef,
  type ProbeResult,
  TOKENIZER_REFS_SCHEMA,
  type TokenizerRefs,
  TRAINING_RUN_SCHEMA,
  type TrainingDataset,
  type TrainingManifest,
  TrainingManifestSchema,
  type TrainingRunReport,
  type WorkerDone,
  type WorkerStart,
  type WorkerVersions,
} from "./schemas";
import {
  type ArtifactStore,
  createMemoryJobStore,
  type JobStore,
} from "./store";
import {
  createPythonWorkerLauncher,
  probeWorker,
  runTrainingWorker,
  type WorkerLauncher,
} from "./worker";

export const MEDIA_TYPES = {
  json: "application/json",
  weights: "application/vnd.mars.peft-adapter-weights+safetensors",
  adapterConfig: "application/vnd.mars.peft-adapter-config+json",
  chatTemplate: "text/x-jinja2",
} as const;

export const PLUMBING_LIMITATION =
  "Training plumbing output only: no held-out agent-level evaluation has compared this adapter with its base. It is not evidence of a useful specialist.";

type UnsignedLineage = Omit<DatasetLineage, "attestation">;
export interface LineageSigner {
  sign(document: UnsignedLineage): Record<string, unknown>;
}

export type DatasetResolver = (
  context: RequestContext,
  dataset: TrainingManifest["datasets"][number],
) => Promise<Uint8Array | null>;

export interface TrainingServiceOptions {
  artifacts: ArtifactStore;
  /** Per-job scratch space (datasets, worker output); removed after each job. */
  workRoot: string;
  /** Host-held signer for `mars.specialist-dataset-lineage/v1`; never a hardcoded key. */
  lineageSigner: LineageSigner;
  /** `training.producer_id` in lineage; must differ from the evaluator id. */
  producerId: string;
  jobs?: JobStore;
  hfCacheDir?: string;
  /** Defaults to the pinned venv launcher; a missing venv surfaces as `worker_unavailable`. */
  launcher?: WorkerLauncher;
  resolveDataset?: DatasetResolver;
  maxConcurrentJobs?: number;
  /** Upper bound on any single job's wall clock regardless of budget. */
  maxDeadlineMs?: number;
  killGraceMs?: number;
  maxDatasetBytes?: number;
  now?: () => number;
  newJobId?: () => string;
}

export interface Preflight {
  manifest: TrainingManifest | null;
  missing: string[];
  datasets: { train: ParsedDataset; validation: ParsedDataset } | null;
  chatTemplate: Uint8Array | null;
  tokenizerFiles: Record<string, string> | null;
  probe: ProbeResult | null;
}

export interface TrainingServiceHandle extends TrainingService {
  preflight(context: RequestContext, manifest: ArtifactRef): Promise<Preflight>;
  inspectRecord(context: RequestContext, jobId: string): Promise<JobRecord>;
  /** Resolves once the job leaves pending/running in this process. */
  wait(context: RequestContext, jobId: string): Promise<JobResult>;
}

export function hfVersionRef(ref: PinnedHfRef): VersionRef {
  return { component: `hf:${ref.repo}`, revision: ref.revision };
}

function workerEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    HF_HOME: path.join(home, "hf-home"),
    LANG: "C.UTF-8",
    PYTHONUNBUFFERED: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONNOUSERSITE: "1",
    HF_HUB_OFFLINE: "1",
    HF_DATASETS_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    HF_HUB_DISABLE_TELEMETRY: "1",
    TOKENIZERS_PARALLELISM: "false",
    WANDB_DISABLED: "true",
  };
  if (process.env.CUDA_VISIBLE_DEVICES !== undefined) {
    env.CUDA_VISIBLE_DEVICES = process.env.CUDA_VISIBLE_DEVICES;
  }
  return env;
}

export function pinMismatches(versions: WorkerVersions): string[] {
  const missing: string[] = [];
  if (!versions.python.startsWith(TRAINING_PINS.python_version_prefix))
    missing.push("worker_pin_mismatch:python");
  if (versions.torch.split("+")[0] !== TRAINING_PINS.torch)
    missing.push("worker_pin_mismatch:torch");
  for (const name of [
    "transformers",
    "trl",
    "peft",
    "datasets",
    "accelerate",
  ] as const) {
    if (versions[name] !== TRAINING_PINS[name])
      missing.push(`worker_pin_mismatch:${name}`);
  }
  return missing;
}

/**
 * Processed-token upper bound used against `budget.max_tokens`: training
 * steps, one evaluation pass over the validation split, and the reload proof
 * (three forward passes over a prompt truncated to `max_length`, then
 * generation).
 */
export function trainingTokenBound(manifest: TrainingManifest): number {
  const {
    max_steps,
    per_device_train_batch_size,
    gradient_accumulation_steps,
    max_length,
  } = manifest.sft;
  const validation = manifest.datasets.find((d) => d.split === "validation");
  const train =
    max_steps *
    per_device_train_batch_size *
    gradient_accumulation_steps *
    max_length;
  const evaluation = (validation?.example_count ?? 0) * max_length;
  const reload = 4 * max_length + manifest.generation.max_new_tokens;
  return train + evaluation + reload;
}

export function createTrainingService(
  options: TrainingServiceOptions,
): TrainingServiceHandle {
  const jobs = options.jobs ?? createMemoryJobStore();
  const hfCacheDir = options.hfCacheDir ?? defaultHfCacheDir();
  const now = options.now ?? Date.now;
  const maxConcurrent = options.maxConcurrentJobs ?? 1;
  const maxDeadlineMs = options.maxDeadlineMs ?? 6 * 60 * 60 * 1000;
  const maxDatasetBytes = options.maxDatasetBytes ?? 64 * 1024 * 1024;
  const running = new Map<
    string,
    { controller: AbortController; finished: Promise<void> }
  >();
  let probeCache: Promise<ProbeResult> | null = null;
  let launcherCache: WorkerLauncher | null = options.launcher ?? null;

  const resolveDataset: DatasetResolver =
    options.resolveDataset ??
    (async (context, dataset) =>
      (await options.artifacts.getByDigest?.(context, dataset.sha256)) ?? null);

  function launcher(): WorkerLauncher {
    launcherCache ??= createPythonWorkerLauncher();
    return launcherCache;
  }

  async function probe(): Promise<ProbeResult> {
    probeCache ??= probeWorker(launcher(), workerEnv(tmpdir())).catch(
      (error) => {
        probeCache = null;
        throw error;
      },
    );
    return probeCache;
  }

  async function loadManifest(
    context: RequestContext,
    ref: ArtifactRef,
  ): Promise<{ manifest: TrainingManifest | null; missing: string[] }> {
    if (!ArtifactRefSchema.safeParse(ref).success)
      return { manifest: null, missing: ["manifest_ref_invalid"] };
    let bytes: Uint8Array;
    try {
      bytes = await options.artifacts.get(context, ref);
    } catch (error) {
      const code =
        error instanceof TrainingError &&
        error.code === "artifact_digest_mismatch"
          ? "manifest_digest_mismatch"
          : "manifest_missing";
      return { manifest: null, missing: [code] };
    }
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      return { manifest: null, missing: ["manifest_not_json"] };
    }
    const parsed = TrainingManifestSchema.safeParse(value);
    if (parsed.success) return { manifest: parsed.data, missing: [] };
    const missing = new Set<string>();
    for (const issue of parsed.error.issues) {
      const [head, ...rest] = issue.path;
      if (
        (head === "base_model" ||
          head === "tokenizer" ||
          head === "chat_template") &&
        rest.at(-1) === "revision"
      ) {
        missing.add(`${head}_revision_not_pinned`);
      } else if (head === "chat_template" && rest.at(-1) === "sha256") {
        missing.add("chat_template_sha256_not_pinned");
      } else {
        missing.add(`manifest_invalid:${issue.path.join(".") || "root"}`);
      }
    }
    return { manifest: null, missing: [...missing] };
  }

  async function checkDatasetManifest(
    context: RequestContext,
    manifest: TrainingManifest,
  ): Promise<string[]> {
    const pin = manifest.dataset_manifest;
    if (!pin) return [];
    let bytes: Uint8Array | null = null;
    try {
      bytes =
        (await options.artifacts.getByDigest?.(context, pin.sha256)) ?? null;
    } catch {
      bytes = null;
    }
    if (!bytes || sha256(bytes) !== pin.sha256)
      return ["dataset_manifest_missing"];
    let splits: TrainingDataset[];
    try {
      const parsed = DatasetManifestSplitsSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
      if (parsed.dataset_id !== pin.dataset_id)
        return ["dataset_manifest_invalid"];
      splits = parsed.splits;
    } catch {
      return ["dataset_manifest_invalid"];
    }
    const key = (datasets: TrainingDataset[]) =>
      canonicalJson(
        [...datasets].sort((a, b) => a.split.localeCompare(b.split)),
      );
    return key(splits) === key(manifest.datasets)
      ? []
      : ["dataset_manifest_splits_mismatch"];
  }

  async function preflight(
    context: RequestContext,
    ref: ArtifactRef,
  ): Promise<Preflight> {
    const result: Preflight = {
      manifest: null,
      missing: [],
      datasets: null,
      chatTemplate: null,
      tokenizerFiles: null,
      probe: null,
    };
    const loaded = await loadManifest(context, ref);
    result.missing.push(...loaded.missing);
    const manifest = loaded.manifest;
    if (!manifest) return result;
    result.manifest = manifest;
    result.missing.push(...(await checkDatasetManifest(context, manifest)));

    const parsed: {
      train: ParsedDataset | null;
      validation: ParsedDataset | null;
    } = { train: null, validation: null };
    for (const split of ["train", "validation"] as const) {
      const dataset = datasetFor(manifest, split);
      let bytes: Uint8Array | null = null;
      try {
        bytes = await resolveDataset(context, dataset);
      } catch {
        bytes = null;
      }
      if (bytes && bytes.byteLength > maxDatasetBytes) {
        result.missing.push(`dataset_too_large:${dataset.dataset_id}`);
        continue;
      }
      const checked = checkDataset(dataset, bytes);
      result.missing.push(...checked.missing);
      parsed[split] = checked.parsed;
    }
    result.missing.push(...checkLeakage(manifest, parsed));
    if (parsed.train && parsed.validation)
      result.datasets = { train: parsed.train, validation: parsed.validation };

    if (!(await baseModelCached(hfCacheDir, manifest.base_model)))
      result.missing.push("base_model_not_cached");
    result.tokenizerFiles = await tokenizerFileDigests(
      hfCacheDir,
      manifest.tokenizer,
    );
    if (!result.tokenizerFiles) result.missing.push("tokenizer_not_cached");
    const template = manifest.chat_template;
    const templateBytes = await readSnapshotFile(
      hfCacheDir,
      { repo: template.repo, revision: template.revision },
      template.path,
      1024 * 1024,
    );
    if (!templateBytes) result.missing.push("chat_template_not_cached");
    else if (sha256(templateBytes) !== template.sha256)
      result.missing.push("chat_template_sha256_mismatch");
    else result.chatTemplate = templateBytes;

    try {
      result.probe = await probe();
    } catch (error) {
      result.missing.push(
        error instanceof TrainingError && error.code === "worker_unavailable"
          ? "worker_unavailable"
          : "worker_probe_failed",
      );
    }
    if (result.probe) {
      result.missing.push(...pinMismatches(result.probe.versions));
      if (manifest.method === "qlora") {
        if (!result.probe.versions.cuda_available)
          result.missing.push("qlora_requires_cuda");
        if (!result.probe.versions.bitsandbytes)
          result.missing.push("qlora_requires_bitsandbytes");
      }
    }
    return result;
  }

  async function record(
    context: RequestContext,
    jobId: string,
  ): Promise<JobRecord> {
    const found = await jobs.get(scopeKey(context.scope), jobId);
    if (!found) throw new TrainingError("job_not_found", jobId);
    if (
      (found.status === "pending" || found.status === "running") &&
      !running.has(jobId)
    ) {
      // A job this process does not own was interrupted (host restart).
      const interrupted: JobRecord = {
        ...found,
        status: "failed",
        updated_at: new Date(now()).toISOString(),
        error: {
          code: "interrupted",
          message: "host restarted while the job was running",
        },
      };
      await jobs.put(interrupted);
      // Its worker's watchdog removes the scratch dir and exits when the owning
      // host dies; another live instance sharing this store may still own it.
      return interrupted;
    }
    return found;
  }

  function result(job: JobRecord): JobResult {
    return {
      job: { job_id: job.job_id, input_manifest: job.input_manifest },
      status: job.status,
      artifacts: job.artifacts,
      cost_usd: null,
    };
  }

  async function update(
    job: JobRecord,
    patch: Partial<JobRecord>,
  ): Promise<JobRecord> {
    const next = {
      ...job,
      ...patch,
      updated_at: new Date(now()).toISOString(),
    };
    await jobs.put(next);
    return next;
  }

  async function execute(
    context: RequestContext,
    initial: JobRecord,
    checked: Preflight & {
      manifest: TrainingManifest;
      datasets: NonNullable<Preflight["datasets"]>;
      chatTemplate: Uint8Array;
      tokenizerFiles: Record<string, string>;
    },
    signal: AbortSignal,
  ): Promise<void> {
    let job = initial;
    const workDir = path.join(
      options.workRoot,
      scopeKey(context.scope),
      job.job_id,
    );
    try {
      await mkdir(path.join(workDir, "out"), { recursive: true, mode: 0o700 });
      const trainPath = path.join(workDir, "train.jsonl");
      const validationPath = path.join(workDir, "validation.jsonl");
      const templatePath = path.join(workDir, "chat_template.jinja");
      await writeFile(trainPath, checked.datasets.train.bytes, { mode: 0o600 });
      await writeFile(validationPath, checked.datasets.validation.bytes, {
        mode: 0o600,
      });
      await writeFile(templatePath, checked.chatTemplate, { mode: 0o600 });
      const { manifest } = checked;
      const start: WorkerStart = {
        type: "start",
        protocol: 1,
        method: manifest.method,
        base: manifest.base_model,
        tokenizer: manifest.tokenizer,
        chat_template_path: templatePath,
        train_path: trainPath,
        validation_path: validationPath,
        hf_cache_dir: hfCacheDir,
        output_dir: path.join(workDir, "out"),
        lora: manifest.lora,
        sft: manifest.sft,
        generation: manifest.generation,
        scratch_dir: workDir,
        watchdog_deadline_seconds:
          Math.max(
            1,
            (Date.parse(job.created_at) + job.deadline_ms - now()) / 1000,
          ) +
          (options.killGraceMs ?? 5000) / 1000 +
          5,
      };
      job = await update(job, { status: "running" });
      let progressWrite = Promise.resolve();
      const outcome = await runTrainingWorker({
        launcher: launcher(),
        start,
        env: workerEnv(workDir),
        deadlineAt: Date.parse(job.created_at) + job.deadline_ms,
        signal,
        now,
        ...(options.killGraceMs !== undefined
          ? { killGraceMs: options.killGraceMs }
          : {}),
        onProgress(step, loss) {
          progressWrite = progressWrite.then(async () => {
            job = await update(job, { progress: { step, loss } });
          });
        },
      });
      await progressWrite;
      if (
        outcome.status !== "completed" ||
        !outcome.done ||
        !outcome.versions
      ) {
        job = await update(job, {
          status: outcome.status === "cancelled" ? "cancelled" : "failed",
          error: outcome.error,
          log_tail: outcome.log_tail,
        });
        return;
      }
      const mismatches = pinMismatches(outcome.versions);
      if (mismatches.length > 0) {
        job = await update(job, {
          status: "failed",
          error: { code: "worker_pin_mismatch", message: mismatches.join(",") },
          log_tail: outcome.log_tail,
        });
        return;
      }
      const artifacts = await packageOutputs(
        context,
        job,
        checked,
        outcome.done,
        outcome.versions,
        path.join(workDir, "out", "adapter"),
      );
      job = await update(job, {
        status: "completed",
        artifacts: artifacts.list,
        report: artifacts.report,
        log_tail: outcome.log_tail,
      });
    } catch (error) {
      job = await update(job, {
        status: signal.aborted ? "cancelled" : "failed",
        error: signal.aborted
          ? null
          : {
              code: error instanceof TrainingError ? error.code : "host_error",
              message: String(
                error instanceof Error ? error.message : error,
              ).slice(0, 2000),
            },
      });
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }

  async function packageOutputs(
    context: RequestContext,
    job: JobRecord,
    checked: {
      manifest: TrainingManifest;
      datasets: NonNullable<Preflight["datasets"]>;
      chatTemplate: Uint8Array;
      tokenizerFiles: Record<string, string>;
    },
    done: WorkerDone,
    versions: WorkerVersions,
    adapterDir: string,
  ): Promise<{ list: ArtifactRef[]; report: ArtifactRef }> {
    const { manifest } = checked;
    const weightsBytes = new Uint8Array(
      await readFile(path.join(adapterDir, "adapter_model.safetensors")),
    );
    const configBytes = new Uint8Array(
      await readFile(path.join(adapterDir, "adapter_config.json")),
    );
    assertSafetensors(weightsBytes);
    assertAdapterConfig(configBytes, manifest);
    const put = (bytes: Uint8Array, mediaType: string) =>
      options.artifacts.put(context, bytes, mediaType);
    const weights = await put(weightsBytes, MEDIA_TYPES.weights);
    const adapterConfig = await put(configBytes, MEDIA_TYPES.adapterConfig);
    const chatTemplate = await put(
      checked.chatTemplate,
      MEDIA_TYPES.chatTemplate,
    );
    const tokenizerRefsDoc: TokenizerRefs = {
      schema: TOKENIZER_REFS_SCHEMA,
      tokenizer: manifest.tokenizer,
      files: checked.tokenizerFiles,
      chat_template: {
        repo: manifest.chat_template.repo,
        revision: manifest.chat_template.revision,
        path: manifest.chat_template.path,
        artifact: chatTemplate,
      },
    };
    const tokenizerRefs = await put(
      canonicalBytes(tokenizerRefsDoc),
      MEDIA_TYPES.json,
    );
    const baseModel = hfVersionRef(manifest.base_model);
    const tokenizer = hfVersionRef(manifest.tokenizer);
    const bundleDoc: AdapterBundle = {
      schema: ADAPTER_BUNDLE_SCHEMA,
      format: "peft-lora",
      method: manifest.method,
      base_model: baseModel,
      tokenizer,
      chat_template_sha256: chatTemplate.sha256,
      weights,
      adapter_config: adapterConfig,
      tokenizer_refs: tokenizerRefs,
      chat_template: chatTemplate,
    };
    const bundle = await put(canonicalBytes(bundleDoc), MEDIA_TYPES.json);
    const configSha256 = sha256(
      canonicalJson({
        manifest_sha256: job.input_manifest.sha256,
        base_model: manifest.base_model,
        tokenizer: manifest.tokenizer,
        chat_template: manifest.chat_template,
        method: manifest.method,
        lora: manifest.lora,
        sft: manifest.sft,
        worker: {
          torch: versions.torch,
          transformers: versions.transformers,
          trl: versions.trl,
          peft: versions.peft,
        },
      }),
    );
    const train = datasetFor(manifest, "train");
    const validation = datasetFor(manifest, "validation");
    const requestSha256s = trainingRequestSha256s([
      checked.datasets.train,
      checked.datasets.validation,
    ]);
    const unsigned: UnsignedLineage = {
      schema: "mars.specialist-dataset-lineage/v1",
      lineage_id: `lineage-${job.job_id}`,
      subject: { specialist_id: manifest.specialist_id, base_model: baseModel },
      datasets: [train, validation].map(
        ({ dataset_id, sha256: digest, split }) => ({
          dataset_id,
          sha256: digest,
          split,
        }),
      ),
      training: {
        job_id: job.job_id,
        producer_id: options.producerId,
        config_sha256: configSha256,
      },
      source_scopes: [
        {
          owner_id: context.scope.owner_id,
          project_id: context.scope.project_id,
        },
      ],
      train_task_ids: train.task_ids,
      validation_task_ids: validation.task_ids,
      ...(requestSha256s.length > 0 ? { request_sha256s: requestSha256s } : {}),
      provenance: { synthetic_fixture: manifest.provenance.synthetic_fixture },
    };
    const lineageDoc = DatasetLineageSchema.parse(
      options.lineageSigner.sign(unsigned),
    );
    const lineage = await put(canonicalBytes(lineageDoc), MEDIA_TYPES.json);
    const reportDoc: TrainingRunReport = {
      schema: TRAINING_RUN_SCHEMA,
      job_id: job.job_id,
      manifest: job.input_manifest,
      config_sha256: configSha256,
      dataset_manifest_sha256: manifest.dataset_manifest?.sha256 ?? null,
      worker_versions: versions,
      metrics: done.metrics,
      reload: done.reload,
      artifacts: {
        adapter_bundle: bundle,
        weights,
        adapter_config: adapterConfig,
        tokenizer_refs: tokenizerRefs,
        chat_template: chatTemplate,
        dataset_lineage: lineage,
      },
      registration: {
        base_model: baseModel,
        tokenizer,
        chat_template: chatTemplate,
        adapter: bundle,
        dataset_lineage: lineage,
        adapter_spec: {
          format: "peft-lora",
          base_model: baseModel,
          tokenizer,
          chat_template_sha256: chatTemplate.sha256,
        },
      },
      synthetic_fixture: manifest.provenance.synthetic_fixture,
      limitations: [PLUMBING_LIMITATION],
    };
    const report = await put(canonicalBytes(reportDoc), MEDIA_TYPES.json);
    return {
      list: [
        bundle,
        weights,
        adapterConfig,
        tokenizerRefs,
        chatTemplate,
        lineage,
        report,
      ],
      report,
    };
  }

  return {
    preflight,
    async validate(context, manifest) {
      const checked = await preflight(context, manifest);
      return { ready: checked.missing.length === 0, missing: checked.missing };
    },
    async estimate(context, manifestRef) {
      const { manifest } = await loadManifest(context, manifestRef);
      let probed: ProbeResult | null = null;
      try {
        probed = await probe();
      } catch {}
      if (!probed)
        return { estimated_usd: null, hardware: ["worker_unavailable"] };
      const hardware = probed.versions.cuda_available
        ? probed.versions.cuda_devices.map((name) => `cuda:${name}`)
        : [`cpu:${probed.cpu_count}-logical-cores`];
      if (manifest) {
        const qloraOk =
          probed.versions.cuda_available &&
          probed.versions.bitsandbytes !== null;
        hardware.push(
          manifest.method === "qlora"
            ? qloraOk
              ? "method:qlora-4bit-nf4"
              : "method:qlora-unavailable(no-cuda-or-bitsandbytes)"
            : "method:lora-fp32",
          `token_bound:${trainingTokenBound(manifest)}`,
        );
      }
      // Local hardware is not metered: MARS reports no dollar figure rather than inventing one.
      return { estimated_usd: null, hardware };
    },
    async submit(context, manifestRef, budget: Budget) {
      const parsedBudget = BudgetSchema.safeParse(budget);
      if (!parsedBudget.success)
        throw new TrainingError(
          "budget_invalid",
          "budget does not match BudgetSchema",
        );
      if (running.size >= maxConcurrent)
        throw new TrainingError(
          "capacity_exhausted",
          `max ${maxConcurrent} concurrent jobs`,
        );
      const checked = await preflight(context, manifestRef);
      if (
        checked.manifest &&
        trainingTokenBound(checked.manifest) > parsedBudget.data.max_tokens
      ) {
        checked.missing.push("budget_tokens_exceeded");
      }
      if (
        checked.missing.length > 0 ||
        !checked.manifest ||
        !checked.datasets ||
        !checked.chatTemplate ||
        !checked.tokenizerFiles
      ) {
        throw new TrainingError(
          "not_ready",
          checked.missing.join(",") || "preflight incomplete",
        );
      }
      if (running.size >= maxConcurrent)
        throw new TrainingError(
          "capacity_exhausted",
          `max ${maxConcurrent} concurrent jobs`,
        );
      const jobId = options.newJobId?.() ?? `train-${randomUUID()}`;
      const timestamp = new Date(now()).toISOString();
      const job: JobRecord = {
        schema_version: 1,
        job_id: jobId,
        scope_key: scopeKey(context.scope),
        input_manifest: manifestRef,
        status: "pending",
        created_at: timestamp,
        updated_at: timestamp,
        deadline_ms: Math.min(parsedBudget.data.max_duration_ms, maxDeadlineMs),
        progress: null,
        error: null,
        artifacts: [],
        report: null,
        log_tail: [],
      };
      await jobs.put(job);
      const controller = new AbortController();
      const entry = {
        controller,
        finished: Promise.resolve(),
      };
      running.set(jobId, entry);
      entry.finished = execute(
        context,
        job,
        checked as Parameters<typeof execute>[2],
        controller.signal,
      ).finally(() => running.delete(jobId));
      const ref: JobRef = { job_id: jobId, input_manifest: manifestRef };
      return ref;
    },
    async inspect(context, jobId) {
      return result(await record(context, jobId));
    },
    inspectRecord: record,
    async cancel(context, jobId) {
      const job = await record(context, jobId);
      if (job.status !== "pending" && job.status !== "running") return;
      const entry = running.get(jobId);
      entry?.controller.abort();
      await entry?.finished;
    },
    async wait(context, jobId) {
      await record(context, jobId);
      await running.get(jobId)?.finished;
      return result(await record(context, jobId));
    },
  };
}

/** Minimal safetensors sanity check: 8-byte LE header length followed by a JSON header. */
/**
 * Normalized-request digests (`@mars/datasets` `requestSha256`) of every user
 * turn in the train and validation examples, sorted. Evaluation compares them
 * with held-out requests; an example without user turns contributes none, and
 * a lineage with none at all is refused there as unverifiable.
 */
function trainingRequestSha256s(datasets: readonly ParsedDataset[]): string[] {
  const digests = new Set<string>();
  for (const dataset of datasets) {
    for (const example of dataset.examples) {
      const { messages } = ConversationalExampleSchema.parse(
        JSON.parse(example),
      );
      for (const message of messages) {
        if (message.role === "user")
          digests.add(requestSha256(message.content));
      }
    }
  }
  return [...digests].sort();
}

function assertSafetensors(bytes: Uint8Array): void {
  if (bytes.byteLength < 8)
    throw new TrainingError("worker_protocol", "adapter weights too short");
  const headerLength = Number(
    new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true),
  );
  if (headerLength <= 0 || 8 + headerLength > bytes.byteLength) {
    throw new TrainingError(
      "worker_protocol",
      "adapter weights are not safetensors",
    );
  }
  try {
    const header = JSON.parse(
      new TextDecoder().decode(bytes.subarray(8, 8 + headerLength)),
    );
    if (
      typeof header !== "object" ||
      header === null ||
      Object.keys(header).filter((k) => k !== "__metadata__").length === 0
    ) {
      throw new Error("empty");
    }
  } catch {
    throw new TrainingError(
      "worker_protocol",
      "adapter weights header is not valid safetensors JSON",
    );
  }
}

function assertAdapterConfig(
  bytes: Uint8Array,
  manifest: TrainingManifest,
): void {
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new TrainingError(
      "worker_protocol",
      "adapter_config.json is not JSON",
    );
  }
  if (
    config.peft_type !== "LORA" ||
    config.base_model_name_or_path !== manifest.base_model.repo ||
    config.revision !== manifest.base_model.revision
  ) {
    throw new TrainingError(
      "worker_protocol",
      "adapter_config.json does not pin the manifest base model",
    );
  }
}
