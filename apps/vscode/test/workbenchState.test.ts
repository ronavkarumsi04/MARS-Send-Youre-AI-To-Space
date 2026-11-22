import { expect, test } from "bun:test";
import { restoreWorkbenchState } from "../src/webview/workbenchState";

const activeId = "6bd9a588-99e7-43ba-a674-840def2cb887";

test("restores chat and task drafts together after the webview is recreated", () => {
  const saved = {
    request: "Keep this task draft",
    criteria: "Preserve this criterion",
    chatDraft: "Unsent chat message",
    activeId,
    page: "settings" as const,
  };
  expect(restoreWorkbenchState(JSON.parse(JSON.stringify(saved)))).toEqual(
    saved,
  );
});

test("restores legacy task drafts and discards invalid chat navigation state", () => {
  expect(
    restoreWorkbenchState({
      request: "Existing task",
      criteria: "Existing criteria",
      chatDraft: 99,
      activeId: "invalid",
      page: "unknown",
    }),
  ).toEqual({
    request: "Existing task",
    criteria: "Existing criteria",
    chatDraft: "",
    activeId: undefined,
    page: "chat",
  });
});
