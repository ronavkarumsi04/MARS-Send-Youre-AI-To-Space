export type WorkbenchPage = "chat" | "tasks" | "extensions" | "settings";

type WorkbenchDrafts = {
  request: string;
  criteria: string;
  chatDraft: string;
  activeId: string | undefined;
  page: WorkbenchPage;
};

export function restoreWorkbenchState(value: unknown): WorkbenchDrafts {
  const saved =
    value && typeof value === "object"
      ? (value as Partial<Record<keyof WorkbenchDrafts, unknown>>)
      : {};
  return {
    request: typeof saved.request === "string" ? saved.request : "",
    criteria: typeof saved.criteria === "string" ? saved.criteria : "",
    chatDraft:
      typeof saved.chatDraft === "string" ? saved.chatDraft.slice(0, 8000) : "",
    activeId:
      typeof saved.activeId === "string" &&
      /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(saved.activeId)
        ? saved.activeId
        : undefined,
    page:
      saved.page === "tasks" ||
      saved.page === "extensions" ||
      saved.page === "settings"
        ? saved.page
        : "chat",
  };
}
