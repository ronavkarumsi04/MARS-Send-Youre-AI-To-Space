import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntegrityError } from "../src";
import {
  CHECKPOINT_ID_PATTERN,
  loadMeta,
  newCheckpointId,
  newToken,
  newWorkspaceId,
  WORKSPACE_ENTRY_PATTERN,
  WORKSPACE_ID_PATTERN,
} from "../src/store";

test("generated ids match the patterns that validation and recovery use", () => {
  const workspaceId = newWorkspaceId();
  expect(workspaceId).toMatch(/^ws_[a-f0-9]{32}$/);
  expect(WORKSPACE_ID_PATTERN.test(workspaceId)).toBe(true);
  expect(newCheckpointId()).toMatch(/^cp_[a-f0-9]{32}$/);
  expect(CHECKPOINT_ID_PATTERN.test(newCheckpointId())).toBe(true);
  expect(newToken()).toMatch(/^[a-f0-9]{32}$/);
  expect(WORKSPACE_ID_PATTERN.test(`${workspaceId}-x`)).toBe(false);
  expect(WORKSPACE_ID_PATTERN.test(newCheckpointId())).toBe(false);
});

test("staging and trash entry names yield their workspace id", () => {
  const workspaceId = newWorkspaceId();
  for (const suffix of [newToken(), `prior-${newToken()}`, "aside-abc-1"]) {
    expect(WORKSPACE_ENTRY_PATTERN.exec(`${workspaceId}-${suffix}`)?.[1]).toBe(
      workspaceId,
    );
  }
  expect(WORKSPACE_ENTRY_PATTERN.exec(workspaceId)).toBeNull();
  expect(WORKSPACE_ENTRY_PATTERN.exec(`${workspaceId}-a_b`)).toBeNull();
});

const workspaceId = `ws_${"a".repeat(32)}`;

async function withRoot(run: (rootDir: string) => Promise<void>) {
  const rootDir = await mkdtemp(join(tmpdir(), "mars-store-"));
  try {
    await mkdir(join(rootDir, "meta"));
    await run(rootDir);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

test("loadMeta rethrows ENOENT when the metadata directory is absent", async () => {
  await withRoot(async (rootDir) => {
    await expect(loadMeta(rootDir, workspaceId)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

test("loadMeta reports lost state when the metadata directory exists without workspace.json", async () => {
  await withRoot(async (rootDir) => {
    await mkdir(join(rootDir, "meta", workspaceId));
    const error = await loadMeta(rootDir, workspaceId).catch((e) => e);
    expect(error).toBeInstanceOf(IntegrityError);
    expect(error.message).toBe("workspace state lost");
    expect(error.cause).toMatchObject({ code: "ENOENT" });
  });
});

test("loadMeta reports lost state when the metadata path is a dangling symlink", async () => {
  await withRoot(async (rootDir) => {
    await symlink(join(rootDir, "missing"), join(rootDir, "meta", workspaceId));
    const error = await loadMeta(rootDir, workspaceId).catch((e) => e);
    expect(error).toBeInstanceOf(IntegrityError);
    expect(error.message).toBe("workspace state lost");
    expect(error.cause).toMatchObject({ code: "ENOENT" });
  });
});
