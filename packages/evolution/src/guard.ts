import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { fail } from "./errors";
import {
  changedPaths,
  matchesAny,
  snapshotDirectory,
  type TreeEntry,
} from "./tree";
import { sha256 } from "./util";

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
}

/**
 * Candidate workspaces and host control state (store, evaluator config,
 * hidden answers, permission policy) must live in disjoint directory trees.
 */
export async function assertDisjointRoots(
  controlRoot: string,
  workRoot: string,
): Promise<void> {
  if (!isAbsolute(controlRoot) || !isAbsolute(workRoot))
    fail("unsafe_path", "control and work roots must be absolute");
  const [control, work] = await Promise.all([
    realpath(controlRoot),
    realpath(workRoot),
  ]);
  if (inside(control, work) || inside(work, control))
    fail("unsafe_path", "candidate work root and control root overlap");
}

/**
 * Digest of a protected host file or directory. Directories are digested as
 * snapshots (symlinks refused), so a swapped file anywhere inside is caught.
 */
export async function digestControlPath(path: string): Promise<string> {
  if (!isAbsolute(path))
    fail("unsafe_path", `control path must be absolute: ${path}`);
  const info = await stat(path).catch(() => null);
  if (!info) return "missing";
  if (info.isDirectory())
    return (await snapshotDirectory(path, { skipDirs: [] })).tree_sha256;
  return sha256(new Uint8Array(await Bun.file(path).arrayBuffer()));
}

export async function digestControlPaths(
  paths: readonly string[],
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const path of [...paths].sort())
    result[path] = await digestControlPath(path);
  return result;
}

/** Throws `tamper_detected` naming every protected path whose digest drifted. */
export async function verifyControlDigests(
  pinned: Readonly<Record<string, string>>,
  phase: string,
): Promise<void> {
  const drifted: string[] = [];
  for (const [path, digest] of Object.entries(pinned))
    if ((await digestControlPath(path)) !== digest) drifted.push(path);
  if (drifted.length > 0)
    fail(
      "tamper_detected",
      `${phase}: protected control state changed: ${drifted.join(", ")}`,
    );
}

/**
 * Defence in depth after a patch or build: whatever the parser accepted,
 * the actual tree difference must stay inside the mutable allowlist and
 * leave every protected path byte-identical.
 */
export function assertTreeChangeAllowed(
  before: readonly TreeEntry[],
  after: readonly TreeEntry[],
  policy: {
    mutable_paths: readonly string[];
    protected_paths: readonly string[];
  },
): string[] {
  const changed = changedPaths(before, after);
  for (const path of changed) {
    if (matchesAny(path, policy.protected_paths))
      fail("protected_path", `protected path changed: ${path}`);
    if (!matchesAny(path, policy.mutable_paths))
      fail(
        "protected_path",
        `path outside the mutable harness paths changed: ${path}`,
      );
  }
  return changed;
}

/** Hidden answers must never be present (by content) in a harness snapshot. */
export function assertNoHoldoutLeak(
  entries: readonly TreeEntry[],
  hiddenDigests: ReadonlySet<string>,
): void {
  for (const entry of entries)
    if (hiddenDigests.has(entry.sha256))
      fail(
        "holdout_leak",
        `harness file ${entry.path} matches a hidden answer file`,
      );
}
