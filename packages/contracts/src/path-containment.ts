import { existsSync, realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

function relation(root: string, candidate: string): string | null {
  const rel = relative(root, candidate);
  return isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)
    ? null
    : rel;
}

/** True when `candidate` is `root` itself or a path below it. */
export function isInsideOrEqual(root: string, candidate: string): boolean {
  return relation(root, candidate) !== null;
}

/** True only when `candidate` is below `root`; `root` itself is not inside. */
export function isStrictlyInside(root: string, candidate: string): boolean {
  const rel = relation(root, candidate);
  return rel !== null && rel !== "";
}

/**
 * Resolves `value` to an absolute path with symlinks expanded. When the path
 * does not exist yet, its nearest existing ancestor is resolved and the
 * missing components are appended.
 */
export function resolveForSafety(value: string): string {
  const absolute = resolve(value);
  try {
    return realpathSync(absolute);
  } catch {
    const suffix: string[] = [];
    let existing = absolute;
    while (!existsSync(existing)) {
      const parent = dirname(existing);
      if (parent === existing) return absolute;
      suffix.unshift(basename(existing));
      existing = parent;
    }
    return resolve(realpathSync(existing), ...suffix);
  }
}
