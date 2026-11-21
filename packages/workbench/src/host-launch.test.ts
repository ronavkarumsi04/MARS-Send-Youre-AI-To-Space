import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@mars/contracts";
import {
  type Launch,
  type LaunchLocation,
  readLaunch,
  readLaunchIfPresent,
  rewriteLaunch,
  taskStateDir,
  writeLaunch,
} from "./host-launch";

const scope = {
  owner_id: "owner",
  project_id: "project",
  workspace_id: "workspace",
};
const task: Task = {
  schema_version: 1,
  task_id: "task",
  session_id: "session-task",
  scope,
  revision: 0,
  request: "Write a fixture",
  acceptance_criteria: ["Source checkout remains unchanged"],
  budget: {
    max_tokens: 64_000,
    max_usd: 0,
    max_duration_ms: 1000,
    max_depth: 1,
    max_concurrency: 1,
  },
  status: "running",
  specialist_revision: null,
  artifacts: [],
};
const launch: Launch = {
  schema_version: 1,
  task_id: "task",
  scope,
  model_id: "fixture/free",
  approvals: { read: true, write: false, execute: false },
  workspace: { provider: "test", workspace_id: "workspace", revision: "r1" },
  cwd: "/isolated",
};

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function location(): Promise<LaunchLocation> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mars-launch-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return { root, scope };
}

test("a task with no state directory or no launch.json has no launch yet", async () => {
  const where = await location();
  expect(await readLaunchIfPresent(where, task)).toBeNull();
  await mkdir(taskStateDir(where, task.task_id), { mode: 0o700 });
  expect(await readLaunchIfPresent(where, task)).toBeNull();
  await expect(readLaunch(where, task)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("launch metadata is written once, atomically, and read back", async () => {
  const where = await location();
  const dir = taskStateDir(where, task.task_id);
  await mkdir(dir, { mode: 0o700 });
  await writeLaunch(where, task, launch);
  expect(await readLaunchIfPresent(where, task)).toEqual(launch);
  await expect(
    writeLaunch(where, task, { ...launch, model_id: "fixture/other" }),
  ).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readdir(dir)).toEqual(["launch.json"]);
  expect((await readLaunch(where, task)).model_id).toBe("fixture/free");
});

test("oversized launch writes and rewrites fail without publishing unreadable state", async () => {
  const where = await location();
  const dir = taskStateDir(where, task.task_id);
  await mkdir(dir, { mode: 0o700 });
  const oversized = { ...launch, cwd: "/" + "x".repeat(128 * 1024) };
  await expect(writeLaunch(where, task, oversized)).rejects.toMatchObject({
    code: "too_large",
  });
  expect(await readdir(dir)).toEqual([]);
  await writeLaunch(where, task, launch);
  await expect(rewriteLaunch(where, task, oversized)).rejects.toMatchObject({
    code: "too_large",
  });
  expect(await readLaunch(where, task)).toEqual(launch);
  expect(await readdir(dir)).toEqual(["launch.json"]);
});

test("corrupt, unreadable or out-of-scope launch metadata throws instead of reading as absent", async () => {
  const where = await location();
  const dir = taskStateDir(where, task.task_id);
  await mkdir(dir, { mode: 0o700 });
  const file = join(dir, "launch.json");
  await writeLaunch(where, task, launch);
  await chmod(file, 0o644);
  await expect(readLaunchIfPresent(where, task)).rejects.toMatchObject({
    code: "internal_error",
  });
  await chmod(file, 0o600);
  await writeFile(file, "{");
  await expect(readLaunchIfPresent(where, task)).rejects.toThrow(SyntaxError);
  await writeFile(file, JSON.stringify({ ...launch, task_id: "other" }));
  await expect(readLaunchIfPresent(where, task)).rejects.toMatchObject({
    code: "internal_error",
  });
});
