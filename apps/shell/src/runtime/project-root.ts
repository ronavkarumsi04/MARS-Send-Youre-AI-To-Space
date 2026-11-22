import { lstatSync, realpathSync } from "node:fs";

// The desktop passes a canonical path. Never adopt a different object or a
// newly resolved alias just because it occupies the same name.
export function projectRootIdentity(root: string): string | undefined {
  try {
    const stat = lstatSync(root, { bigint: true });
    if (stat.isDirectory() && stat.ino && realpathSync.native(root) === root)
      return [stat.dev, stat.ino, stat.birthtimeNs].join(":");
  } catch {
    // Missing and inaccessible roots have no identity to approve.
  }
  return undefined;
}

export function requireProjectRoot(root: string, expected?: string): string {
  if (!expected || projectRootIdentity(root) !== expected)
    throw new Error(
      "The selected project directory has changed. Reopen it before adding Filesystem.",
    );
  return expected;
}
