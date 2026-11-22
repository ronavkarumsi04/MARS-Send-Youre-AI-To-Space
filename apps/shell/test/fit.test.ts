import { expect, test } from "bun:test";
import { renderShell, type ShellState } from "../src/renderer/view";
import { findAll, MiniDocument, type MiniElement } from "./mini-dom";
import { loadFixtureData } from "./test-utils";

function byClass(root: MiniElement, className: string): MiniElement[] {
  return findAll(root, (element) =>
    (element.getAttribute("class") ?? "").split(" ").includes(className),
  );
}

test("task cards retain full request titles and budget values have individual labels", async () => {
  const data = await loadFixtureData();
  const selectedTask = data.tasks[0];
  if (!selectedTask) throw new Error("Missing fixture task");
  const doc = new MiniDocument();
  const root = renderShell(doc, {
    page: "tasks",
    tasks: data.tasks,
    selectedTask,
    inspectorOpen: true,
    events: [],
    artifacts: [],
  }) as MiniElement;
  expect(
    byClass(root, "session-request")
      .map((el) => el.getAttribute("title"))
      .sort(),
  ).toEqual(data.tasks.map((task) => task.request).sort());
  const budget = byClass(root, "budget")[0];
  if (!budget) throw new Error("Missing budget");
  const labels = findAll(budget, (el) => el.tagName === "DT");
  const values = findAll(budget, (el) => el.tagName === "DD");
  expect(labels.map((el) => el.textContent)).toEqual([
    "Tokens",
    "Cost limit",
    "Duration",
    "Depth",
    "Concurrency",
  ]);
  expect(values.map((el) => el.textContent)).toEqual([
    String(selectedTask.budget.max_tokens),
    `$${selectedTask.budget.max_usd}`,
    `${selectedTask.budget.max_duration_ms} ms`,
    String(selectedTask.budget.max_depth),
    String(selectedTask.budget.max_concurrency),
  ]);
  expect(byClass(root, "task-actions")[0]?.textContent).toBe(
    "RefreshHide details",
  );
});

test.each([undefined, "Workbench resource was not found."])(
  "empty and error task views keep actions separate without stale budget metadata (%s)",
  (error) => {
    const doc = new MiniDocument();
    const state: ShellState = {
      tasks: [],
      events: [],
      artifacts: [],
      ...(error ? { error } : {}),
    };
    const root = renderShell(doc, state) as MiniElement;
    expect(byClass(root, "session-request")).toHaveLength(0);
    expect(byClass(root, "budget")).toHaveLength(0);
    if (error) expect(root.textContent).toContain(error);
    else
      expect(byClass(root, "task-actions")[0]?.textContent).toBe(
        "RefreshTask details",
      );
  },
);
