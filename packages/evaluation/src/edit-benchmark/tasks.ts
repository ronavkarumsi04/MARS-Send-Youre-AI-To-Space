import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, sha256 } from "@mars/contracts/canonical";
import {
  createHeldOutGuard,
  HELD_OUT_SPLIT_SCHEMA,
  type HeldOutSplit,
  type TrainingLineageView,
} from "@mars/datasets";
import { z } from "zod";

export const EDIT_BENCHMARK_SUITE_SCHEMA = "mars.edit-benchmark-suite/v1";
export const EDIT_BENCHMARK_TASK_SCHEMA = "mars.edit-benchmark-task/v1";

export const EDIT_TASK_CATEGORIES = [
  "multi_site",
  "whitespace_sensitive",
  "large_file",
  "repeated_lines",
] as const;

const Id = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/);
const Provenance = z
  .object({
    origin: z.enum(["authored", "derived"]),
    created: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    author: z.string().min(1).optional(),
    notes: z.string().min(1).optional(),
    statement: z.string().min(1).optional(),
    source: z
      .object({
        repository: z.string().url(),
        commit: z.string().regex(/^[a-f0-9]{40}$/),
        license: z.string().min(1),
        path: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

export const EditBenchmarkTaskSchema = z
  .object({
    schema: z.literal(EDIT_BENCHMARK_TASK_SCHEMA),
    task_id: Id,
    category: z.enum(EDIT_TASK_CATEGORIES),
    complexity: z.enum(["light", "medium", "heavy"]),
    instruction: z.string().min(1).max(8192),
    provenance: Provenance,
  })
  .strict();
export type EditBenchmarkTaskMeta = z.infer<typeof EditBenchmarkTaskSchema>;

export const EditBenchmarkSuiteSchema = z
  .object({
    schema: z.literal(EDIT_BENCHMARK_SUITE_SCHEMA),
    suite_id: Id,
    revision: z.string().min(1),
    domain: z.string().regex(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/),
    tasks: z.array(Id).min(1),
    provenance: Provenance,
    /** Upstream repositories derived tasks were taken from. */
    sources: z
      .array(
        z
          .object({
            slug: Id,
            repository: z.string().url(),
            commit: z.string().regex(/^[a-f0-9]{40}$/),
            license: z.string().min(1),
            license_file: z.string().min(1),
            language: z.string().min(1),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

/** A task with its starting tree and the exact tree a solve must produce. */
export interface EditBenchmarkTask extends EditBenchmarkTaskMeta {
  before: ReadonlyMap<string, Uint8Array>;
  after: ReadonlyMap<string, Uint8Array>;
}

export interface EditBenchmarkSuite {
  suite_id: string;
  revision: string;
  domain: string;
  provenance: z.infer<typeof Provenance>;
  sources: NonNullable<z.infer<typeof EditBenchmarkSuiteSchema>["sources"]>;
  tasks: EditBenchmarkTask[];
  /** Digest over every task's metadata and both trees. */
  sha256: string;
  split: HeldOutSplit & { sha256: string };
}

/**
 * v2: 144 tasks derived from pinned, permissively licensed public code; sized
 * for the pre-registered power analysis. Default for `mars bench`.
 */
export const EDIT_BENCHMARK_SUITE_V2_DIR = fileURLToPath(
  new URL("../../fixtures/edit-benchmark/v2", import.meta.url),
);

/** v1: the original 10 hand-written tasks (kept intact; exploratory only). */
export const EDIT_BENCHMARK_SUITE_V1_DIR = fileURLToPath(
  new URL("../../fixtures/edit-benchmark/v1", import.meta.url),
);

/** Per-file size cap: `mars_read` returns whole files up to 128 KB. */
export const MAX_EDIT_TASK_FILE_BYTES = 128 * 1024;

async function readTree(root: string): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink())
        throw new Error(`Benchmark trees may not contain symlinks: ${path}`);
      if (info.isDirectory()) await walk(path);
      else if (info.isFile()) {
        const bytes = new Uint8Array(await readFile(path));
        if (bytes.byteLength > MAX_EDIT_TASK_FILE_BYTES)
          throw new Error(`Benchmark file exceeds 128 KB: ${path}`);
        files.set(relative(root, path).split(sep).join("/"), bytes);
      }
    }
  };
  await walk(root);
  return new Map([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

const treeDigest = (tree: ReadonlyMap<string, Uint8Array>) =>
  [...tree].map(([path, bytes]) => [path, sha256(bytes)]);

/** Loads `<dir>/suite.json` and `<dir>/tasks/<id>/{task.json,before/,after/}`. */
export async function loadEditBenchmarkSuite(
  dir: string,
): Promise<EditBenchmarkSuite> {
  const suite = EditBenchmarkSuiteSchema.parse(
    JSON.parse(await readFile(join(dir, "suite.json"), "utf8")),
  );
  if (new Set(suite.tasks).size !== suite.tasks.length)
    throw new Error("Benchmark suite lists a task twice.");
  const tasks: EditBenchmarkTask[] = [];
  for (const id of suite.tasks) {
    const root = join(dir, "tasks", id);
    const meta = EditBenchmarkTaskSchema.parse(
      JSON.parse(await readFile(join(root, "task.json"), "utf8")),
    );
    if (meta.task_id !== id)
      throw new Error(`Task directory ${id} declares ${meta.task_id}.`);
    if (meta.provenance.origin === "derived") {
      const source = meta.provenance.source;
      if (
        !source ||
        !suite.sources?.some(
          (s) =>
            s.repository === source.repository &&
            s.commit === source.commit &&
            s.license === source.license,
        )
      )
        throw new Error(
          `Derived task ${id} must name a source listed by the suite.`,
        );
    }
    const before = await readTree(join(root, "before"));
    const after = await readTree(join(root, "after"));
    if (before.size === 0) throw new Error(`Task ${id} has no files.`);
    if (treeDigest(before).toString() === treeDigest(after).toString())
      throw new Error(`Task ${id} expects no change.`);
    tasks.push({ ...meta, before, after });
  }
  const digest = sha256(
    canonicalJson([
      EDIT_BENCHMARK_SUITE_SCHEMA,
      suite.suite_id,
      suite.revision,
      tasks.map((task) => [
        task.task_id,
        task.category,
        task.complexity,
        task.instruction,
        treeDigest(task.before),
        treeDigest(task.after),
      ]),
    ]),
  );
  const split: HeldOutSplit = {
    schema: HELD_OUT_SPLIT_SCHEMA,
    split_id: suite.suite_id,
    tasks: tasks.map((task) => ({
      task_id: task.task_id,
      domain: suite.domain,
      role: "worker" as const,
      complexity: task.complexity,
      request: task.instruction,
    })),
  };
  return {
    suite_id: suite.suite_id,
    revision: suite.revision,
    domain: suite.domain,
    provenance: suite.provenance,
    sources: suite.sources ?? [],
    tasks,
    sha256: digest,
    split: createHeldOutGuard(split).split(),
  };
}

/**
 * Refuses a suite whose tasks reached any of the given training lineages
 * (task id, normalized request text or digest, or the split itself), using
 * the same rules as the specialist held-out comparison.
 */
export function assertHeldOut(
  suite: EditBenchmarkSuite,
  lineages: readonly TrainingLineageView[],
): void {
  const { sha256: _digest, ...split } = suite.split;
  const guard = createHeldOutGuard(split);
  for (const lineage of lineages) {
    const leaks = guard.findLeakage(lineage);
    if (leaks.length > 0)
      throw new Error(
        `heldout_leakage: ${leaks.length} benchmark task(s) are in a training lineage (${leaks
          .slice(0, 3)
          .map((leak) => `${leak.task_id}:${leak.reason}`)
          .join(", ")})`,
      );
  }
}

export interface TreeVerification {
  solved: boolean;
  /** True when the workspace could not be inspected; always unsolved. */
  unreadable?: boolean;
  changed: string[];
  missing: string[];
  unexpected: string[];
  mismatched: string[];
}

/** Host-side check: the workspace must equal the expected tree byte for byte. */
export async function verifyWorkspace(
  root: string,
  task: EditBenchmarkTask,
): Promise<TreeVerification> {
  let actual: Map<string, Uint8Array>;
  try {
    actual = await readTree(root);
  } catch {
    // An uninspectable workspace (oversized file, symlink, unreadable entry)
    // never counts as a solve, even for tasks that expect an empty tree.
    return {
      solved: false,
      changed: [],
      missing: [...task.after.keys()],
      unexpected: [],
      mismatched: [],
      unreadable: true,
    };
  }
  const same = (a: Uint8Array | undefined, b: Uint8Array | undefined) =>
    a !== undefined &&
    b !== undefined &&
    a.byteLength === b.byteLength &&
    a.every((value, index) => value === b[index]);
  const missing = [...task.after.keys()].filter((path) => !actual.has(path));
  const unexpected = [...actual.keys()].filter((path) => !task.after.has(path));
  const mismatched = [...task.after.keys()].filter(
    (path) => actual.has(path) && !same(actual.get(path), task.after.get(path)),
  );
  const changed = [...actual.keys()].filter(
    (path) => !same(actual.get(path), task.before.get(path)),
  );
  return {
    solved:
      missing.length === 0 &&
      unexpected.length === 0 &&
      mismatched.length === 0,
    changed,
    missing,
    unexpected,
    mismatched,
  };
}
