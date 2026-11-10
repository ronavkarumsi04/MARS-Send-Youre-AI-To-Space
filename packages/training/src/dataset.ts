import { canonicalJson, sha256 } from "./canonical";
import {
  ConversationalExampleSchema,
  type TrainingDataset,
  type TrainingManifest,
} from "./schemas";

export interface ParsedDataset {
  dataset: TrainingDataset;
  bytes: Uint8Array;
  /** Canonical JSON of every example, in file order. */
  examples: string[];
}

/**
 * Verifies one JSONL file against its manifest entry: exact-byte sha256,
 * strict UTF-8, one TRL conversational example per line, example count.
 * Returns `missing` codes instead of throwing so validate can list them all.
 */
export function checkDataset(
  dataset: TrainingDataset,
  bytes: Uint8Array | null,
): { parsed: ParsedDataset | null; missing: string[] } {
  const id = dataset.dataset_id;
  if (!bytes) return { parsed: null, missing: [`dataset_missing:${id}`] };
  if (sha256(bytes) !== dataset.sha256) {
    return { parsed: null, missing: [`dataset_sha256_mismatch:${id}`] };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { parsed: null, missing: [`dataset_not_utf8:${id}`] };
  }
  const lines = text.endsWith("\n")
    ? text.slice(0, -1).split("\n")
    : text.split("\n");
  const examples: string[] = [];
  for (const [index, line] of lines.entries()) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return {
        parsed: null,
        missing: [`dataset_malformed:${id}:${index + 1}`],
      };
    }
    const parsed = ConversationalExampleSchema.safeParse(value);
    if (!parsed.success) {
      return {
        parsed: null,
        missing: [`dataset_malformed:${id}:${index + 1}`],
      };
    }
    examples.push(canonicalJson(parsed.data));
  }
  if (examples.length !== dataset.example_count) {
    return { parsed: null, missing: [`dataset_example_count_mismatch:${id}`] };
  }
  return { parsed: { dataset, bytes, examples }, missing: [] };
}

/**
 * Training-side leakage checks. Train and validation must not share task ids,
 * bytes, or identical examples, and neither may touch the declared held-out
 * split. The registry repeats the task-id/split check against the signed
 * evaluation report (`lineage_leakage`); this refuses before compute is spent.
 */
export function checkLeakage(
  manifest: TrainingManifest,
  parsed: { train: ParsedDataset | null; validation: ParsedDataset | null },
): string[] {
  const missing: string[] = [];
  const train = datasetFor(manifest, "train");
  const validation = datasetFor(manifest, "validation");
  const validationTasks = new Set(validation.task_ids);
  if (train.task_ids.some((task) => validationTasks.has(task))) {
    missing.push("leakage:train_validation_task_overlap");
  }
  if (train.sha256 === validation.sha256) {
    missing.push("leakage:train_validation_identical");
  }
  if (parsed.train && parsed.validation) {
    const trainExamples = new Set(parsed.train.examples);
    if (
      parsed.validation.examples.some((example) => trainExamples.has(example))
    ) {
      missing.push("leakage:train_validation_example_overlap");
    }
  }
  if (manifest.heldout) {
    const heldoutTasks = new Set(manifest.heldout.task_ids);
    if (
      [...train.task_ids, ...validation.task_ids].some((task) =>
        heldoutTasks.has(task),
      )
    ) {
      missing.push("leakage:heldout_task_overlap");
    }
    if (
      manifest.datasets.some(
        (dataset) => dataset.sha256 === manifest.heldout?.split_sha256,
      )
    ) {
      missing.push("leakage:heldout_split_reused");
    }
  }
  return missing;
}

export function datasetFor(
  manifest: TrainingManifest,
  split: "train" | "validation",
): TrainingDataset {
  const dataset = manifest.datasets.find((item) => item.split === split);
  if (!dataset) throw new Error(`manifest has no ${split} dataset`);
  return dataset;
}
