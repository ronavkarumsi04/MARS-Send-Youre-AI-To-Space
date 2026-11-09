import type { RequestContext, WorkspaceRef } from "@mars/contracts";
import {
  isSecretPath,
  relativePathProblem,
  ScopeSchema,
} from "@mars/contracts";
import { ContextPolicyError } from "./errors";
import type { RepositoryMapLimits } from "./types";

const dependencySegments = new Set([
  "node_modules",
  "bower_components",
  "vendor",
  ".venv",
  "venv",
  ".yarn",
  ".pnpm-store",
  "site-packages",
  "jspm_packages",
]);
const privateSegments = new Set([
  ".git",
  ".hg",
  ".svn",
  ".mars",
  ".omp",
  ".devin",
  ".cache",
  ".idea",
  ".vscode",
]);
const ignoredSegments = new Set([
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".parcel-cache",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".tox",
  ".gradle",
  ".terraform",
  "target",
]);

export function validateContext(context: RequestContext): void {
  try {
    if (
      context?.schema_version !== 1 ||
      typeof context.request_id !== "string" ||
      context.request_id.length === 0 ||
      !ScopeSchema.safeParse(context.scope).success
    ) {
      throw new Error("invalid");
    }
  } catch {
    throw new ContextPolicyError("Invalid request context");
  }
}

export function validateWorkspaceScope(
  context: RequestContext,
  workspace: Pick<WorkspaceRef, "workspace_id">,
): void {
  if (
    context.scope.workspace_id !== undefined &&
    context.scope.workspace_id !== workspace.workspace_id
  ) {
    throw new ContextPolicyError("Workspace is outside the request scope");
  }
}

export function validateRelativePath(
  value: string,
  limits: RepositoryMapLimits,
): string {
  if (relativePathProblem(value) !== null) {
    throw new ContextPolicyError("Invalid relative path");
  }
  const segments = value.split("/");
  if (
    Buffer.byteLength(value, "utf8") > limits.maxPathBytes ||
    segments.length > limits.maxDepth
  ) {
    throw new ContextPolicyError("Invalid relative path");
  }
  return segments.join("/");
}

export function classifyPath(
  path: string,
): "dependency" | "private_state" | "ignored" | "secret" | undefined {
  const segments = path.split("/").map((part) => part.toLowerCase());
  if (segments.some((part) => dependencySegments.has(part)))
    return "dependency";
  if (
    segments.some(
      (part) =>
        privateSegments.has(part) ||
        part.startsWith(".aider") ||
        part === ".aider.tags.cache.v3" ||
        part === ".aider.tags.cache.v4",
    )
  ) {
    return "private_state";
  }
  if (segments.some((part) => ignoredSegments.has(part))) return "ignored";
  if (isSecretPath(path)) return "secret";
  return undefined;
}

export function isSupportedLanguage(path: string): boolean {
  return /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py)$/i.test(path);
}

export function isGeneratedName(path: string): boolean {
  return /\.(?:min\.js|min\.mjs|bundle\.js|chunk\.js|map)$/i.test(path);
}
