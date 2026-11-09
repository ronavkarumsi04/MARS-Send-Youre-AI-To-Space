import { expect, test } from "bun:test";
import {
  CHECKPOINT_ID_PATTERN,
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
