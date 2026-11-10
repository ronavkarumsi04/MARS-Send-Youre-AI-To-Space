import { createHash } from "node:crypto";
import { z } from "zod";

export const HELD_OUT_SPLIT_SCHEMA = "mars.held-out-split/v1";

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/** Identical to the request normalization `buildDataset` uses to hold out repeated requests. */
export const normalizeRequest = (text: string) =>
  text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

const Id = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/);

export const HeldOutTaskSchema = z
  .object({
    task_id: Id,
    domain: z.string().regex(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/),
    role: z.enum(["lead", "worker", "reviewer"]),
    complexity: z.enum(["light", "medium", "heavy"]),
    request: z.string().min(1).max(65_536).optional(),
  })
  .strict();
export type HeldOutTask = z.infer<typeof HeldOutTaskSchema>;

/** Evaluation-only tasks, labelled per routing triple; never trained on. */
export const HeldOutSplitSchema = z
  .object({
    schema: z.literal(HELD_OUT_SPLIT_SCHEMA),
    split_id: Id,
    tasks: z
      .array(HeldOutTaskSchema)
      .min(1)
      .refine(
        (tasks) =>
          new Set(tasks.map((task) => task.task_id)).size === tasks.length,
        "duplicate task_id",
      ),
  })
  .strict();
export type HeldOutSplit = z.infer<typeof HeldOutSplitSchema>;

export function parseHeldOutSplit(value: unknown): HeldOutSplit {
  return HeldOutSplitSchema.parse(value);
}

/** Order-independent digest of a split: tasks sorted by id, keys sorted. */
export function heldOutSplitSha256(split: HeldOutSplit): string {
  const tasks = [...split.tasks]
    .sort((a, b) =>
      a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0,
    )
    .map((task) => [
      task.task_id,
      task.domain,
      task.role,
      task.complexity,
      task.request === undefined ? null : normalizeRequest(task.request),
    ]);
  return sha256(JSON.stringify([split.schema, split.split_id, tasks]));
}

/** What a model was trained or validated on (from its dataset lineage / manifest). */
export interface TrainingLineageView {
  task_ids: readonly string[];
  requests?: readonly string[];
  dataset_sha256s?: readonly string[];
}

export type HeldOutLeakageReason =
  | "training-task"
  | "training-request"
  | "training-dataset";

export interface HeldOutLeak {
  task_id: string;
  reason: HeldOutLeakageReason;
}

/**
 * Held-out tasks that reached the training lineage: by task id, by the same
 * normalized request text `buildDataset` holds out, or because the split
 * itself was registered as a training dataset. Empty means disjoint.
 */
export function findHeldOutLeakage(
  split: HeldOutSplit,
  training: TrainingLineageView,
): HeldOutLeak[] {
  const ids = new Set(training.task_ids);
  const requests = new Set((training.requests ?? []).map(normalizeRequest));
  const splitSha = heldOutSplitSha256(split);
  const datasetLeak = (training.dataset_sha256s ?? []).includes(splitSha);
  const leaks: HeldOutLeak[] = [];
  for (const task of split.tasks) {
    if (ids.has(task.task_id))
      leaks.push({ task_id: task.task_id, reason: "training-task" });
    else if (
      task.request !== undefined &&
      requests.has(normalizeRequest(task.request))
    )
      leaks.push({ task_id: task.task_id, reason: "training-request" });
    else if (datasetLeak)
      leaks.push({ task_id: task.task_id, reason: "training-dataset" });
  }
  return leaks;
}

/**
 * The held-out guard `@mars/evaluation`'s specialist comparison consumes: it
 * serves one split and enforces exclusion against a candidate's lineage.
 */
export function createHeldOutGuard(split: HeldOutSplit) {
  const parsed = parseHeldOutSplit(split);
  const digest = heldOutSplitSha256(parsed);
  return {
    split: () => ({ ...parsed, sha256: digest }),
    findLeakage: (training: TrainingLineageView) =>
      findHeldOutLeakage(parsed, training),
  };
}
