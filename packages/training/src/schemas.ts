import { ArtifactRefSchema, VersionRefSchema } from "@mars/contracts";
import type { DATASET_SCHEMA, DatasetSplit } from "@mars/datasets";
import { IdSchema } from "@mars/specialists";
import { z } from "zod";

export const TRAINING_MANIFEST_SCHEMA = "mars.training-manifest/v1";
export const TRAINING_RUN_SCHEMA = "mars.training-run/v1";
export const ADAPTER_BUNDLE_SCHEMA = "mars.peft-adapter/v1";
export const TOKENIZER_REFS_SCHEMA = "mars.tokenizer-refs/v1";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
/** Exact Hugging Face commit revision; branch and tag names are refused. */
export const ExactRevisionSchema = z
  .string()
  .regex(/^[a-f0-9]{40}$/, "must be an exact 40-hex commit revision");
/** `org/name` Hugging Face repo id. */
export const HfRepoSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .refine((value) => !value.includes(".."), "must not contain ..");
const RepoFileSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/)
  .refine(
    (value) => value.split("/").every((part) => part !== ".." && part !== "."),
    "must be a plain relative path",
  );

export const PinnedHfRefSchema = z
  .object({ repo: HfRepoSchema, revision: ExactRevisionSchema })
  .strict();
export type PinnedHfRef = z.infer<typeof PinnedHfRefSchema>;

export const TrainingDatasetSchema = z
  .object({
    dataset_id: IdSchema,
    split: z.enum(["train", "validation"]),
    sha256: Sha256Schema,
    example_count: z.number().int().positive().max(1_000_000),
    task_ids: z
      .array(IdSchema)
      .min(1)
      .refine((ids) => new Set(ids).size === ids.length, "must be unique"),
  })
  .strict();
export type TrainingDataset = z.infer<typeof TrainingDatasetSchema>;

export const TrainingManifestSchema = z
  .object({
    schema: z.literal(TRAINING_MANIFEST_SCHEMA),
    manifest_id: IdSchema,
    specialist_id: IdSchema,
    base_model: PinnedHfRefSchema,
    tokenizer: PinnedHfRefSchema,
    chat_template: z
      .object({
        repo: HfRepoSchema,
        revision: ExactRevisionSchema,
        path: RepoFileSchema,
        sha256: Sha256Schema,
      })
      .strict(),
    datasets: z.array(TrainingDatasetSchema).min(2).max(2),
    /**
     * The `mars.training-dataset/v1` manifest (`@mars/datasets`) the split
     * entries were copied from; when set, they must equal its `splits`.
     */
    dataset_manifest: z
      .object({ dataset_id: IdSchema, sha256: Sha256Schema })
      .strict()
      .optional(),
    /** Held-out evaluation split the training data must never touch. */
    heldout: z
      .object({
        split_sha256: Sha256Schema,
        task_ids: z.array(IdSchema),
      })
      .strict()
      .nullable(),
    method: z.enum(["lora", "qlora"]),
    lora: z
      .object({
        r: z.number().int().min(1).max(256),
        alpha: z.number().int().min(1).max(1024),
        dropout: z.number().min(0).max(0.5),
        target_modules: z.union([
          z.literal("all-linear"),
          z.array(z.string().regex(/^[A-Za-z0-9_.]+$/)).min(1),
        ]),
      })
      .strict(),
    sft: z
      .object({
        max_steps: z.number().int().min(1).max(100_000),
        learning_rate: z.number().positive().max(1),
        per_device_train_batch_size: z.number().int().min(1).max(512),
        gradient_accumulation_steps: z.number().int().min(1).max(512),
        max_length: z.number().int().min(16).max(131_072),
        seed: z
          .number()
          .int()
          .min(0)
          .max(2 ** 31 - 1),
      })
      .strict(),
    generation: z
      .object({ max_new_tokens: z.number().int().min(1).max(256) })
      .strict(),
    provenance: z.object({ synthetic_fixture: z.boolean() }).strict(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const splits = manifest.datasets.map((dataset) => dataset.split).sort();
    if (splits[0] !== "train" || splits[1] !== "validation") {
      ctx.addIssue({
        code: "custom",
        path: ["datasets"],
        message: "needs exactly one train and one validation dataset",
      });
    }
  });
export type TrainingManifest = z.infer<typeof TrainingManifestSchema>;

export const DATASET_MANIFEST_SCHEMA: typeof DATASET_SCHEMA =
  "mars.training-dataset/v1";

/** The part of an `@mars/datasets` manifest the trainer consumes. */
export const DatasetManifestSplitsSchema = z
  .object({
    schema: z.literal(DATASET_MANIFEST_SCHEMA),
    dataset_id: IdSchema,
    format: z.literal("trl-conversational"),
    splits: z.array(TrainingDatasetSchema).length(2),
  })
  .passthrough()
  .refine(
    (manifest) =>
      manifest.splits
        .map((split) => split.split)
        .sort()
        .join() === "train,validation",
    "needs exactly one train and one validation split",
  );

/** `@mars/datasets` split entries are training-manifest dataset entries as-is. */
export function datasetsFromDatasetManifest(value: unknown): TrainingDataset[] {
  return DatasetManifestSplitsSchema.parse(value).splits;
}

const splitIsTrainingDataset = (split: DatasetSplit): TrainingDataset => split;
void splitIsTrainingDataset;

/** One TRL conversational example: `{"messages":[{role, content}]}`. */
export const ConversationalExampleSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.enum(["system", "user", "assistant"]),
            content: z.string(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .refine(
    (example) => example.messages.some((m) => m.role === "assistant"),
    "needs at least one assistant message",
  );

// ---- worker protocol --------------------------------------------------------

export const WorkerVersionsSchema = z
  .object({
    python: z.string(),
    torch: z.string(),
    transformers: z.string(),
    trl: z.string(),
    peft: z.string(),
    datasets: z.string(),
    accelerate: z.string(),
    bitsandbytes: z.string().nullable(),
    cuda_available: z.boolean(),
    cuda_devices: z.array(z.string()),
  })
  .strict();
export type WorkerVersions = z.infer<typeof WorkerVersionsSchema>;

export const ProbeMessageSchema = z
  .object({
    type: z.literal("probe"),
    versions: WorkerVersionsSchema,
    cpu_count: z.number().int().positive(),
  })
  .strict();
export type ProbeResult = z.infer<typeof ProbeMessageSchema>;

export const TrainingMetricsSchema = z
  .object({
    global_steps: z.number().int().nonnegative(),
    train_loss: z.number(),
    eval_loss: z.number().nullable(),
    train_seconds: z.number().nonnegative(),
    trainable_params: z.number().int().nonnegative(),
    total_params: z.number().int().nonnegative(),
    train_examples: z.number().int().nonnegative(),
    validation_examples: z.number().int().nonnegative(),
    device: z.enum(["cpu", "cuda"]),
  })
  .strict();

export const ReloadProofSchema = z
  .object({
    loaded: z.literal(true),
    max_abs_logit_diff_vs_trained: z.number(),
    max_abs_logit_diff_vs_base: z.number(),
    prompt_tokens: z.number().int().nonnegative(),
    generated_tokens: z.number().int().nonnegative(),
    generated_text: z.string().max(2000),
  })
  .strict();

export const WorkerMessageSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("ready"), versions: WorkerVersionsSchema })
    .strict(),
  z
    .object({
      type: z.literal("progress"),
      step: z.number().int().nonnegative(),
      loss: z.number(),
    })
    .strict(),
  z
    .object({
      type: z.literal("done"),
      files: z.tuple([
        z.literal("adapter_model.safetensors"),
        z.literal("adapter_config.json"),
      ]),
      metrics: TrainingMetricsSchema,
      reload: ReloadProofSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("error"),
      code: z.string().max(64),
      message: z.string().max(2000),
    })
    .strict(),
]);
export type WorkerMessage = z.infer<typeof WorkerMessageSchema>;
export type WorkerDone = Extract<WorkerMessage, { type: "done" }>;

export interface WorkerStart {
  type: "start";
  protocol: 1;
  method: TrainingManifest["method"];
  base: PinnedHfRef;
  tokenizer: PinnedHfRef;
  chat_template_path: string;
  train_path: string;
  validation_path: string;
  hf_cache_dir: string;
  output_dir: string;
  lora: TrainingManifest["lora"];
  sft: TrainingManifest["sft"];
  generation: TrainingManifest["generation"];
}

// ---- output documents --------------------------------------------------------

export const TokenizerRefsSchema = z
  .object({
    schema: z.literal(TOKENIZER_REFS_SCHEMA),
    tokenizer: PinnedHfRefSchema,
    files: z.record(RepoFileSchema, Sha256Schema),
    chat_template: z
      .object({
        repo: HfRepoSchema,
        revision: ExactRevisionSchema,
        path: RepoFileSchema,
        artifact: ArtifactRefSchema,
      })
      .strict(),
  })
  .strict();
export type TokenizerRefs = z.infer<typeof TokenizerRefsSchema>;

export const AdapterBundleSchema = z
  .object({
    schema: z.literal(ADAPTER_BUNDLE_SCHEMA),
    format: z.literal("peft-lora"),
    method: z.enum(["lora", "qlora"]),
    base_model: VersionRefSchema,
    tokenizer: VersionRefSchema,
    chat_template_sha256: Sha256Schema,
    weights: ArtifactRefSchema,
    adapter_config: ArtifactRefSchema,
    tokenizer_refs: ArtifactRefSchema,
    chat_template: ArtifactRefSchema,
  })
  .strict();
export type AdapterBundle = z.infer<typeof AdapterBundleSchema>;

export const TrainingRunReportSchema = z
  .object({
    schema: z.literal(TRAINING_RUN_SCHEMA),
    job_id: IdSchema,
    manifest: ArtifactRefSchema,
    config_sha256: Sha256Schema,
    dataset_manifest_sha256: Sha256Schema.nullable(),
    worker_versions: WorkerVersionsSchema,
    metrics: TrainingMetricsSchema,
    reload: ReloadProofSchema,
    artifacts: z
      .object({
        adapter_bundle: ArtifactRefSchema,
        weights: ArtifactRefSchema,
        adapter_config: ArtifactRefSchema,
        tokenizer_refs: ArtifactRefSchema,
        chat_template: ArtifactRefSchema,
        dataset_lineage: ArtifactRefSchema,
      })
      .strict(),
    /** Fields a specialist registration must carry to match this adapter. */
    registration: z
      .object({
        base_model: VersionRefSchema,
        tokenizer: VersionRefSchema,
        chat_template: ArtifactRefSchema,
        adapter: ArtifactRefSchema,
        dataset_lineage: ArtifactRefSchema,
        adapter_spec: z
          .object({
            format: z.literal("peft-lora"),
            base_model: VersionRefSchema,
            tokenizer: VersionRefSchema,
            chat_template_sha256: Sha256Schema,
          })
          .strict(),
      })
      .strict(),
    synthetic_fixture: z.boolean(),
    limitations: z.array(z.string().max(500)),
  })
  .strict();
export type TrainingRunReport = z.infer<typeof TrainingRunReportSchema>;

export const JobRecordSchema = z
  .object({
    schema_version: z.literal(1),
    job_id: IdSchema,
    scope_key: z.string(),
    input_manifest: ArtifactRefSchema,
    status: z.enum(["pending", "running", "completed", "failed", "cancelled"]),
    created_at: z.string(),
    updated_at: z.string(),
    deadline_ms: z.number().int().positive(),
    progress: z
      .object({ step: z.number().int().nonnegative(), loss: z.number() })
      .strict()
      .nullable(),
    error: z
      .object({ code: z.string(), message: z.string().max(2000) })
      .strict()
      .nullable(),
    artifacts: z.array(ArtifactRefSchema),
    report: ArtifactRefSchema.nullable(),
    log_tail: z.array(z.string().max(1000)).max(200),
  })
  .strict();
export type JobRecord = z.infer<typeof JobRecordSchema>;
