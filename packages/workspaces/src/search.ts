import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { isSecretPath } from "@mars/contracts";
import { isInsideOrEqual } from "@mars/contracts/path-containment";
import { grep } from "@oh-my-pi/pi-natives";
import { z } from "zod";
import { WorkspacePolicyError } from "./errors";
import {
  ignoredNames,
  isIgnored,
  resolveSafePath,
  validateRelativePath,
} from "./paths";
import { DEFAULT_WORKSPACE_LIMITS, type WorkspaceLimits } from "./tree";

export const MAX_SEARCH_BYTES = 64 * 1024;
export const MAX_SEARCH_COLUMNS = 512;
export const SearchRequestSchema = z
  .object({
    pattern: z.string().min(1).max(4096),
    literal: z.boolean().optional(),
    path: z.string().min(1).max(4096).optional(),
    glob: z.string().min(1).max(1024).optional(),
    ignore_case: z.boolean().optional(),
    context: z.number().int().nonnegative().optional(),
    max_matches: z.number().int().positive().optional(),
  })
  .strict();
export type WorkspaceSearchRequest = z.infer<typeof SearchRequestSchema> & {
  signal?: AbortSignal;
};
export interface SearchLine {
  lineNumber: number;
  line: string;
}
export interface WorkspaceSearchMatch extends SearchLine {
  path: string;
  contextBefore?: SearchLine[];
  contextAfter?: SearchLine[];
}
export interface WorkspaceSearchResult {
  matches: WorkspaceSearchMatch[];
  truncated: boolean;
  limitReached: boolean;
}

export async function searchWorkspaceTree(
  tree: string,
  request: WorkspaceSearchRequest,
  limits: WorkspaceLimits = DEFAULT_WORKSPACE_LIMITS,
  extraIgnores: readonly string[] = [],
): Promise<WorkspaceSearchResult> {
  const { signal, ...params } = request;
  const input = SearchRequestSchema.parse(params);
  if (signal?.aborted)
    throw new WorkspacePolicyError("Workspace search was cancelled");
  const scope =
    input.path === undefined
      ? undefined
      : validateRelativePath(input.path, limits, extraIgnores);
  let target: string;
  let root: string;
  let fileScope: boolean;
  try {
    target = scope === undefined ? tree : await resolveSafePath(tree, scope);
    root = await realpath(tree);
    if (!isInsideOrEqual(root, await realpath(target)))
      throw new WorkspacePolicyError("Invalid search scope");
    fileScope = (await lstat(target)).isFile();
  } catch {
    throw new WorkspacePolicyError(
      "Search scope is unavailable or not allowed",
    );
  }
  const searchRoot = fileScope ? dirname(target) : target;
  const maxCount = Math.min(input.max_matches ?? 100, 200);
  const context = Math.min(input.context ?? 0, 5);
  const glob = fileScope
    ? basename(target).replace(/[?*[\]{}]/g, "\\$&")
    : input.glob;
  let found: Awaited<ReturnType<typeof grep>>;
  try {
    found = await grep({
      pattern: input.literal
        ? input.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        : input.pattern,
      path: searchRoot,
      ...(glob ? { glob } : {}),
      ...(fileScope ? { recursive: false } : {}),
      exclude: [...ignoredNames, ...extraIgnores],
      gitignore: true,
      hidden: true,
      ...(input.ignore_case !== undefined
        ? { ignoreCase: input.ignore_case }
        : {}),
      maxCount,
      contextBefore: context,
      contextAfter: context,
      maxColumns: MAX_SEARCH_COLUMNS,
      timeoutMs: 5000,
      ...(signal ? { signal } : {}),
    });
  } catch {
    throw new WorkspacePolicyError("Workspace search failed or was cancelled");
  }
  if (signal?.aborted)
    throw new WorkspacePolicyError("Workspace search was cancelled");
  const result: WorkspaceSearchResult = {
    matches: [],
    truncated: Boolean(found.limitReached || found.skippedOversized),
    limitReached: Boolean(found.limitReached),
  };
  const cleanLine = (value: SearchLine): SearchLine => {
    const line = Array.from(value.line)
      .filter(
        (character) =>
          character >= " " && character !== String.fromCharCode(127),
      )
      .slice(0, MAX_SEARCH_COLUMNS)
      .join("");
    if (line !== value.line) result.truncated = true;
    return { lineNumber: value.lineNumber, line };
  };
  for (const match of found.matches) {
    const path = relative(
      tree,
      isAbsolute(match.path) ? match.path : join(searchRoot, match.path),
    );
    if (fileScope && path !== scope) continue;
    try {
      if (isIgnored(path, extraIgnores) || isSecretPath(path)) continue;
      validateRelativePath(path, limits, extraIgnores);
      const safe = await resolveSafePath(tree, path);
      if (
        !(await lstat(safe)).isFile() ||
        !isInsideOrEqual(root, await realpath(safe))
      )
        continue;
    } catch {
      continue;
    }
    const entry: WorkspaceSearchMatch = {
      path,
      ...cleanLine(match),
      contextBefore:
        context === 0
          ? []
          : (match.contextBefore ?? []).slice(-context).map(cleanLine),
      contextAfter: (match.contextAfter ?? []).slice(0, context).map(cleanLine),
    };
    if (match.truncated) result.truncated = true;
    result.matches.push(entry);
    if (
      Buffer.byteLength(JSON.stringify(result), "utf8") >
      MAX_SEARCH_BYTES - 64
    ) {
      result.matches.pop();
      result.truncated = result.limitReached = true;
      break;
    }
  }
  return result;
}
