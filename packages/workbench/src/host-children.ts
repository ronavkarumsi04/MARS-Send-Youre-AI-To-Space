import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { type FrozenRouting, FrozenRoutingSchema } from "./specialist-routing";

/**
 * The workspace id a child's tree is prepared under. The runner derives child
 * task ids by suffixing the parent's, which can exceed the provider's 128
 * character limit for a valid parent; such ids map to a stable digest alias.
 */
export function childWorkspaceTaskId(childTaskId: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(childTaskId))
    return childTaskId;
  return "child." + createHash("sha256").update(childTaskId).digest("hex");
}

/**
 * Private per-task and per-child records kept under the host state root:
 * the models a task already used (so reviewers are routed elsewhere) and
 * each child's routing decision, both surviving pauses and host restarts.
 */
export function createChildRecords(stateRoot: string) {
  const childRouting = new Map<string, FrozenRouting>();
  // Models already used inside a task (coordinator and children) so a
  // reviewer child can be routed to a different one; per child, whether its
  // review was independent, mirrored into the child.result event.
  // The history is durable (private per-task record) and selection is
  // serialized per task, so it survives pauses and host restarts and two
  // children routed concurrently can never both claim the same model.
  const TaskModelsSchema = z
    .object({
      models: z.array(z.string().min(1)),
      verdicts: z.record(z.string(), z.boolean()),
    })
    .strict();
  type TaskModels = z.infer<typeof TaskModelsSchema>;
  const taskModels = new Map<string, TaskModels>();
  const taskModelLocks = new Map<string, Promise<unknown>>();
  const taskModelsPath = (taskId: string) =>
    join(
      stateRoot,
      "children",
      "models",
      childWorkspaceTaskId(taskId) + ".json",
    );
  const loadTaskModels = async (taskId: string): Promise<TaskModels> => {
    const known = taskModels.get(taskId);
    if (known) return known;
    // Only a missing file is an empty history (it is created on first
    // save). A corrupt or unreadable one throws so it is never cached or
    // overwritten, which would drop models a reviewer must avoid.
    const text = await readFile(taskModelsPath(taskId), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
    const record =
      text === null
        ? { models: [], verdicts: {} }
        : TaskModelsSchema.parse(JSON.parse(text));
    taskModels.set(taskId, record);
    return record;
  };
  // Cached only once durable: a restart must never find less history than
  // the models this process already handed out.
  const saveTaskModels = async (taskId: string, record: TaskModels) => {
    const path = taskModelsPath(taskId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = path + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    taskModels.set(taskId, record);
  };
  const forgetTaskModels = async (taskId: string) => {
    taskModels.delete(taskId);
    await rm(taskModelsPath(taskId), { force: true }).catch(() => undefined);
  };
  const withTaskModelLock = async <T>(
    taskId: string,
    work: () => Promise<T>,
  ): Promise<T> => {
    const previous = taskModelLocks.get(taskId) ?? Promise.resolve();
    const run = previous.then(work, work);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    taskModelLocks.set(taskId, settled);
    try {
      return await run;
    } finally {
      if (taskModelLocks.get(taskId) === settled) taskModelLocks.delete(taskId);
    }
  };
  /** Routing decisions survive a host restart in a private per-child record. */
  const childRoutingPath = (childTaskId: string) =>
    join(
      stateRoot,
      "children",
      "routing",
      childWorkspaceTaskId(childTaskId) + ".json",
    );
  const rememberChildRouting = async (
    childTaskId: string,
    routing: FrozenRouting,
  ) => {
    childRouting.set(childTaskId, routing);
    const path = childRoutingPath(childTaskId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = path + "." + randomUUID() + ".tmp";
    await writeFile(temporary, JSON.stringify(routing), { mode: 0o600 });
    await rename(temporary, path);
  };
  const recallChildRouting = async (
    childTaskId: string,
  ): Promise<FrozenRouting | null> => {
    const known = childRouting.get(childTaskId);
    if (known) return known;
    const parsed = await readFile(childRoutingPath(childTaskId), "utf8")
      .then((text) => FrozenRoutingSchema.safeParse(JSON.parse(text)))
      .catch(() => null);
    if (!parsed?.success) return null;
    childRouting.set(childTaskId, parsed.data);
    return parsed.data;
  };
  const forgetChildRouting = async (childTaskId: string) => {
    childRouting.delete(childTaskId);
    await rm(childRoutingPath(childTaskId), { force: true }).catch(
      () => undefined,
    );
  };
  return {
    loadTaskModels,
    saveTaskModels,
    forgetTaskModels,
    withTaskModelLock,
    rememberChildRouting,
    recallChildRouting,
    forgetChildRouting,
  };
}
