import { lstat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isSecretPath, relativePathProblem } from "@mars/contracts";
import { WorkspacePolicyError } from "./errors";
import type { WorkspaceLimits } from "./tree";

export {
  hasUnsupportedPathCharacters,
  isSecretPath as isSecret,
} from "@mars/contracts";

export const ignoredNames = new Set([
  ".git",
  ".hg",
  ".svn",
  ".mars",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".tox",
  ".gradle",
  ".terraform",
]);

export function isIgnored(
  path: string,
  extraIgnores: readonly string[] = [],
): boolean {
  return path.split("/").some((segment) => {
    const normalizedSegment = segment.toLowerCase();
    if (ignoredNames.has(normalizedSegment)) return true;
    return extraIgnores.some((pattern) => {
      const normalizedPattern = pattern.toLowerCase();
      return normalizedPattern.includes("*")
        ? new RegExp(
            `^${normalizedPattern.split("*").map(escapeRegex).join(".*")}$`,
          ).test(normalizedSegment)
        : normalizedPattern === normalizedSegment;
    });
  });
}

export function validateRelativePath(
  path: string,
  limits: WorkspaceLimits,
  extraIgnores: readonly string[] = [],
): string {
  if (relativePathProblem(path) !== null) {
    throw new WorkspacePolicyError("Invalid relative workspace path");
  }
  const segments = path.split("/");
  if (
    Buffer.byteLength(path, "utf8") > limits.maxPathBytes ||
    segments.length > limits.maxDepth
  ) {
    throw new WorkspacePolicyError("Workspace path exceeds policy limits");
  }
  if (isIgnored(path, extraIgnores) || isSecretPath(path)) {
    throw new WorkspacePolicyError("Workspace path is ignored or secret");
  }
  return segments.join("/");
}

export async function resolveSafePath(
  root: string,
  relativePath: string,
): Promise<string> {
  const segments = relativePath.split("/");
  let current = root;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment === undefined)
      throw new WorkspacePolicyError("Invalid relative workspace path");
    current = join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink())
        throw new WorkspacePolicyError("Symlink paths are not allowed");
      if (i < segments.length - 1 && !stat.isDirectory()) {
        throw new WorkspacePolicyError(
          "A workspace path parent is not a directory",
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  if (!isAbsolute(current))
    throw new WorkspacePolicyError("Invalid workspace path");
  return current;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
