import { createHash } from "node:crypto";
import { secretShapeRegexes } from "@mars/contracts";

export const DATASET_SCHEMA = "mars.training-dataset/v1";

/** The fixed system turn of every example; its digest is in the manifest. */
export const DATASET_SYSTEM_PROMPT =
  "You are a coding agent. Reply with a unified diff that resolves the request.";

export interface VerifiedExample {
  task_id: string;
  scope: { owner_id: string; project_id: string };
  request: string;
  /** The exact exported patch bytes the host verdict ran against. */
  patch: string;
  patch_sha256: string;
  verdict_run_id: string;
  check_manifest_sha256: string | null;
}

/** Tasks (and their request texts) reserved for evaluation; never trained on. */
export interface HeldOutSet {
  source: string;
  task_ids: readonly string[];
  requests?: readonly string[];
}

export type ExclusionReason =
  | "held-out-task"
  | "held-out-request"
  | "patch-mismatch"
  | "empty"
  | "secret"
  | "private-path"
  | "too-large"
  | "duplicate";

export interface DatasetSplit {
  dataset_id: string;
  split: "train" | "validation";
  sha256: string;
  example_count: number;
  task_ids: string[];
}

export interface DatasetManifest {
  schema: typeof DATASET_SCHEMA;
  dataset_id: string;
  format: "trl-conversational";
  system_prompt_sha256: string;
  splits: DatasetSplit[];
  sources: (Omit<VerifiedExample, "request" | "patch" | "scope"> &
    VerifiedExample["scope"])[];
  source_scopes: VerifiedExample["scope"][];
  held_out: { source: string; task_count: number; sha256: string }[];
  excluded: { task_id: string; reason: ExclusionReason }[];
  policy: {
    validation_fraction: number;
    seed: string;
    max_example_chars: number;
  };
}

export interface BuildDatasetInput {
  dataset_id: string;
  examples: readonly VerifiedExample[];
  held_out: readonly HeldOutSet[];
  /**
   * Host-private roots (state dirs, workspaces, home); examples mentioning
   * them are dropped. Required and non-empty: the builder cannot know them.
   */
  private_patterns: readonly string[];
  validation_fraction?: number;
  seed?: string;
  max_example_chars?: number;
}

export interface BuiltDataset {
  manifest: DatasetManifest;
  files: { train: Uint8Array; validation: Uint8Array };
}

export class DatasetError extends Error {
  constructor(
    readonly code: "empty" | "leakage" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "DatasetError";
  }
}

const sha256 = (text: string | Uint8Array) =>
  createHash("sha256").update(text).digest("hex");
const normalize = (text: string) =>
  text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const SECRETS = secretShapeRegexes();
const ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Builds a deterministic train/validation dataset from verified examples.
 * Held-out tasks are excluded by id and by normalized request text, and the
 * result is re-checked for leakage before it is returned. Splits are by
 * groups of examples sharing a task id or normalized request, so neither a
 * task nor a repeated request appears in both.
 */
export function buildDataset(input: BuildDatasetInput): BuiltDataset {
  const fraction = input.validation_fraction ?? 0.1;
  const seed = input.seed ?? "mars";
  const maxChars = input.max_example_chars ?? 65_536;
  if (!ID.test(input.dataset_id))
    throw new DatasetError("invalid", "Invalid dataset id.");
  if (!(fraction > 0 && fraction < 1))
    throw new DatasetError("invalid", "validation_fraction must be in (0, 1).");
  const heldIds = new Set(input.held_out.flatMap((set) => set.task_ids));
  // A held-out task's own request text is held out too, so a renamed copy is
  // caught even when the held-out set lists only ids.
  const heldRequests = new Set([
    ...input.held_out.flatMap((set) => (set.requests ?? []).map(normalize)),
    ...input.examples
      .filter((example) => heldIds.has(example.task_id))
      .map((example) => normalize(example.request)),
  ]);
  const privatePatterns = (input.private_patterns ?? []).filter(
    (pattern) => pattern.trim().length > 0,
  );
  if (privatePatterns.length === 0)
    throw new DatasetError("invalid", "private_patterns must name host roots.");
  const ordered = [...input.examples].sort((a, b) =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0,
  );
  const kept: VerifiedExample[] = [];
  const excluded: DatasetManifest["excluded"] = [];
  const seen = new Set<string>();
  for (const example of ordered) {
    const reason = exclusion(example);
    if (reason) excluded.push({ task_id: example.task_id, reason });
    else kept.push(example);
  }
  function exclusion(example: VerifiedExample): ExclusionReason | null {
    if (heldIds.has(example.task_id)) return "held-out-task";
    if (heldRequests.has(normalize(example.request))) return "held-out-request";
    if (sha256(example.patch) !== example.patch_sha256) return "patch-mismatch";
    if (!example.request.trim() || !example.patch.trim()) return "empty";
    const text = `${example.request}\n${example.patch}`;
    if (SECRETS.some((pattern) => pattern.test(text))) return "secret";
    if (privatePatterns.some((pattern) => text.includes(pattern)))
      return "private-path";
    if (text.length > maxChars) return "too-large";
    const identity = sha256(`${normalize(example.request)}\0${example.patch}`);
    if (seen.has(identity)) return "duplicate";
    seen.add(identity);
    return null;
  }
  if (kept.length === 0)
    throw new DatasetError("empty", "No verified examples remain.");
  for (const example of kept)
    if (
      heldIds.has(example.task_id) ||
      heldRequests.has(normalize(example.request))
    )
      throw new DatasetError("leakage", "A held-out task reached the dataset.");

  // Examples sharing a task id or a normalized request form one group, and a
  // group lands wholly in one split.
  const parent = new Map<string, string>();
  const find = (node: string): string => {
    let root = node;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    return root;
  };
  const link = (a: string, b: string) => {
    for (const node of [a, b]) if (!parent.has(node)) parent.set(node, node);
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  for (const e of kept)
    link(`t:${e.task_id}`, `r:${sha256(normalize(e.request))}`);
  const group = (e: VerifiedExample) => find(`t:${e.task_id}`);
  const bucket = (id: string) =>
    Number.parseInt(sha256(`${seed}\0${id}`).slice(0, 8), 16) / 2 ** 32;
  const groups = [...new Set(kept.map(group))].sort();
  let validationGroups = new Set(groups.filter((g) => bucket(g) < fraction));
  if (validationGroups.size === 0 && groups.length >= 2) {
    const lowest = groups.reduce((a, b) => (bucket(b) < bucket(a) ? b : a));
    validationGroups = new Set([lowest]);
  }
  if (validationGroups.size === groups.length)
    validationGroups = new Set(groups.slice(1));
  const train = kept.filter((e) => !validationGroups.has(group(e)));
  const validation = kept.filter((e) => validationGroups.has(group(e)));
  const files = { train: jsonl(train), validation: jsonl(validation) };
  const split = (
    name: "train" | "validation",
    rows: VerifiedExample[],
  ): DatasetSplit => ({
    dataset_id: `${input.dataset_id}-${name}`,
    split: name,
    sha256: sha256(files[name]),
    example_count: rows.length,
    task_ids: [...new Set(rows.map((e) => e.task_id))],
  });
  const scopes = new Map(
    kept.map((e) => [`${e.scope.owner_id}\0${e.scope.project_id}`, e.scope]),
  );
  return {
    files,
    manifest: {
      schema: DATASET_SCHEMA,
      dataset_id: input.dataset_id,
      format: "trl-conversational",
      system_prompt_sha256: sha256(DATASET_SYSTEM_PROMPT),
      splits: [split("train", train), split("validation", validation)],
      sources: kept.map((e) => ({
        owner_id: e.scope.owner_id,
        project_id: e.scope.project_id,
        task_id: e.task_id,
        verdict_run_id: e.verdict_run_id,
        patch_sha256: e.patch_sha256,
        check_manifest_sha256: e.check_manifest_sha256,
      })),
      source_scopes: [...scopes.keys()]
        .sort()
        .map((k) => scopes.get(k) as VerifiedExample["scope"]),
      held_out: [...input.held_out]
        .map((set) => ({
          source: set.source,
          task_count: new Set(set.task_ids).size,
          sha256: sha256(
            JSON.stringify({
              task_ids: [...new Set(set.task_ids)].sort(),
              requests: [
                ...new Set((set.requests ?? []).map(normalize)),
              ].sort(),
            }),
          ),
        }))
        .sort((a, b) =>
          a.source < b.source ? -1 : a.source > b.source ? 1 : 0,
        ),
      excluded,
      policy: {
        validation_fraction: fraction,
        seed,
        max_example_chars: maxChars,
      },
    },
  };
}

function key(example: VerifiedExample): string {
  return `${example.scope.owner_id}\0${example.scope.project_id}\0${example.task_id}\0${example.patch_sha256}`;
}

function jsonl(rows: VerifiedExample[]): Uint8Array {
  return new TextEncoder().encode(
    rows
      .map(
        (row) =>
          `${JSON.stringify({
            messages: [
              { role: "system", content: DATASET_SYSTEM_PROMPT },
              { role: "user", content: row.request },
              { role: "assistant", content: row.patch },
            ],
          })}\n`,
      )
      .join(""),
  );
}
