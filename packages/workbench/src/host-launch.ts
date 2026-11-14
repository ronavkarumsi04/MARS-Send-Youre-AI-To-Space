import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, realpath, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  RequiredCheckSchema,
  type Scope,
  ScopeSchema,
  type Task,
} from "@mars/contracts";
import { isInsideOrEqual } from "@mars/contracts/path-containment";
import { z } from "zod";
import { FrozenCollaborationSchema } from "./collaboration-context";
import { FrozenInstructionsSchema } from "./conventions-context";
import {
  FrozenGraphSummarySchema,
  validateFrozenGraphSummary,
} from "./graph-context";
import { errorCodeOf } from "./host-shared";
import { FrozenMemorySchema, validateFrozenMemory } from "./memory-context";
import { ApprovalsSchema, WorkspaceRefSchema } from "./protocol";
import {
  FrozenRepositoryMapSchema,
  validateFrozenRepositoryMap,
} from "./repository-context";
import { WorkbenchError } from "./server";
import { FrozenSkillsSchema, validateFrozenSkills } from "./skills-context";
import { FrozenRoutingSchema, ModelRebindSchema } from "./specialist-routing";

/** Immutable per-task launch metadata, pinned in the host-private state root. */
export const launchSchema = z
  .object({
    schema_version: z.literal(1),
    task_id: z.string().min(1),
    scope: ScopeSchema,
    model_id: z.string().min(1),
    edit_format: z
      .object({
        format: z.enum(["hashline", "replace", "apply_patch"]),
        requested: z.enum(["hashline", "replace", "apply_patch"]),
        source: z.enum(["config", "default"]),
      })
      .strict()
      .optional(),
    model_classification: z
      .object({ tier: z.enum(["free", "paid", "local"]), free: z.boolean() })
      .strict()
      .optional(),
    deadline: z.number().int().positive().optional(),
    approvals: ApprovalsSchema,
    workspace: WorkspaceRefSchema,
    cwd: z.string().min(1).refine(isAbsolute),
    memory: FrozenMemorySchema.optional(),
    skills: FrozenSkillsSchema.optional(),
    repository_map: FrozenRepositoryMapSchema.optional(),
    knowledge_graph: FrozenGraphSummarySchema.optional(),
    instructions: FrozenInstructionsSchema.optional(),
    routing: FrozenRoutingSchema.optional(),
    /**
     * Resume-time model replacements, oldest first: a lost specialist pin was
     * replaced by its routed fallback and the saved journal rebound to it.
     */
    model_rebinds: z.array(ModelRebindSchema).min(1).max(32).optional(),
    collaboration: FrozenCollaborationSchema.optional(),
    /** Host-run checks fixed at launch; the model never sees or edits them. */
    required_checks: z.array(RequiredCheckSchema).max(32).optional(),
  })
  .strict();
export type Launch = z.infer<typeof launchSchema>;

/** Where a host keeps per-task private state: its state root and scope. */
export interface LaunchLocation {
  root: string;
  scope: Scope;
}

function scopeKey(scope: Scope, taskId: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        scope.owner_id,
        scope.project_id,
        scope.workspace_id ?? null,
        taskId,
      ]),
    )
    .digest("hex");
}

export function taskStateDir(location: LaunchLocation, taskId: string): string {
  return join(location.root, scopeKey(location.scope, taskId));
}

/**
 * Reads and integrity-checks a task's launch metadata. Every failure throws:
 * a missing launch surfaces its ENOENT, an escaped path is `not_found`, and
 * bad permissions, oversize or out-of-scope records are `internal_error`.
 */
export async function readLaunch(
  location: LaunchLocation,
  task: Task,
): Promise<Launch> {
  const dir = taskStateDir(location, task.task_id);
  if (!isInsideOrEqual(location.root, dir) || (await realpath(dir)) !== dir)
    throw new WorkbenchError("not_found");
  const file = await open(
    join(dir, "launch.json"),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 128 * 1024)
      throw new WorkbenchError("internal_error");
    const value = launchSchema.parse(JSON.parse(await file.readFile("utf8")));
    if (value.repository_map) {
      const map = value.repository_map;
      validateFrozenRepositoryMap(map);
      if (
        !value.approvals.read ||
        map.scope.owner_id !== task.scope.owner_id ||
        map.scope.project_id !== task.scope.project_id ||
        map.scope.workspace_id !== task.scope.workspace_id ||
        map.workspace.workspace_id !== value.workspace.workspace_id ||
        map.workspace.provider !== value.workspace.provider ||
        map.workspace.revision !== value.workspace.revision
      )
        throw new WorkbenchError("internal_error");
    }
    if (value.knowledge_graph) {
      const graph = value.knowledge_graph;
      validateFrozenGraphSummary(graph);
      if (
        !value.approvals.read ||
        graph.scope.owner_id !== task.scope.owner_id ||
        graph.scope.project_id !== task.scope.project_id ||
        graph.scope.workspace_id !== task.scope.workspace_id ||
        graph.workspace.workspace_id !== value.workspace.workspace_id ||
        graph.workspace.provider !== value.workspace.provider ||
        graph.workspace.revision !== value.workspace.revision
      )
        throw new WorkbenchError("internal_error");
    }
    if (value.memory) {
      validateFrozenMemory(value.memory);
      if (
        value.memory.scope.owner_id !== task.scope.owner_id ||
        value.memory.scope.project_id !== task.scope.project_id ||
        value.memory.scope.workspace_id !== task.scope.workspace_id
      )
        throw new WorkbenchError("internal_error");
    }
    if (value.skills) {
      validateFrozenSkills(value.skills);
      if (!value.approvals.read) throw new WorkbenchError("internal_error");
    }
    if (
      value.task_id !== task.task_id ||
      value.scope.owner_id !== task.scope.owner_id ||
      value.scope.project_id !== task.scope.project_id ||
      value.scope.workspace_id !== task.scope.workspace_id
    )
      throw new WorkbenchError("internal_error");
    return value;
  } finally {
    await file.close();
  }
}

/**
 * A task that has not launched yet has no launch metadata; only that case
 * (a missing state directory or `launch.json`) reads as `null`. Corrupt,
 * tampered or unreadable metadata still throws.
 */
export async function readLaunchIfPresent(
  location: LaunchLocation,
  task: Task,
): Promise<Launch | null> {
  try {
    return await readLaunch(location, task);
  } catch (error) {
    if (errorCodeOf(error) === "ENOENT") return null;
    throw error;
  }
}

export async function writeLaunch(
  location: LaunchLocation,
  task: Task,
  launch: Launch,
): Promise<void> {
  const dir = taskStateDir(location, task.task_id);
  if ((await realpath(dir)) !== dir || ((await stat(dir)).mode & 0o077) !== 0)
    throw new WorkbenchError("internal_error");
  // Written aside and linked into place: `link` refuses an existing launch
  // like O_EXCL did, and readers only ever see a missing or complete file.
  const temporary = join(dir, "launch.json." + randomUUID());
  const file = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      await file.writeFile(JSON.stringify(launchSchema.parse(launch)));
      await file.sync();
    } finally {
      await file.close();
    }
    await link(temporary, join(dir, "launch.json"));
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function rewriteLaunch(
  location: LaunchLocation,
  task: Task,
  launch: Launch,
): Promise<void> {
  const dir = taskStateDir(location, task.task_id);
  if ((await realpath(dir)) !== dir || ((await stat(dir)).mode & 0o077) !== 0)
    throw new WorkbenchError("internal_error");
  const temporary = join(dir, "launch.json." + randomUUID());
  const file = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(JSON.stringify(launchSchema.parse(launch)));
  } finally {
    await file.close();
  }
  await rename(temporary, join(dir, "launch.json"));
}
