import { isAbsolute, relative, sep } from "node:path";

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
