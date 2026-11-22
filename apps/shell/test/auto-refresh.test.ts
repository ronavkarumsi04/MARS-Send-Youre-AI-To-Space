import { expect, test } from "bun:test";
import { createTeamChatBridge } from "../src/main/team-chat-bridge";
import { createController } from "../src/renderer/controller";
import { READ_METHODS, type ShellBridge } from "../src/shared/methods";
import {
  TEAM_CHAT_METHODS,
  type TeamChatBridgeApi,
} from "../src/shared/team-chat";
import { findAll, MiniDocument, serialize } from "./mini-dom";
import { fakeBridge, loadFixtureData, type RecordedCall } from "./test-utils";

function fakeTimers() {
  let time = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const delays: number[] = [];
  return {
    delays,
    get count() {
      return timers.size;
    },
    scheduleRefresh(callback: () => void, delay: number) {
      const id = nextId++;
      delays.push(delay);
      timers.set(id, { at: time + delay, callback });
      return () => {
        timers.delete(id);
      };
    },
    advance(ms: number) {
      time += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at > time) continue;
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

test("auto-refresh preserves unsubmitted Team Chat search text, focus, and caret", async () => {
  const fixture = await loadFixtureData();
  const teamBridge = createTeamChatBridge();
  const teamApi = Object.fromEntries(
    TEAM_CHAT_METHODS.map((method) => [
      method,
      (params: unknown) => teamBridge.call(method, params),
    ]),
  ) as TeamChatBridgeApi;
  const doc = new MiniDocument();
  const timers = fakeTimers();
  const controller = createController(
    fakeBridge(fixture),
    doc,
    doc.root,
    teamApi,
    timers,
  );
  try {
    await controller.load();
    findAll(
      doc.root,
      (element) => element.getAttribute("data-action") === "toggle-team-chat",
    )[0]?.click();
    await Bun.sleep(0);
    const search = () =>
      findAll(
        doc.root,
        (element) => element.getAttribute("class") === "team-search-input",
      )[0];
    const input = search();
    if (!input) throw new Error("search input missing");
    input.value = "unfinished search";
    input.dispatch("input");
    input.focus();
    input.setSelectionRange(3, 8, "backward");
    timers.advance(3000);
    await controller.settled();
    const refreshed = search();
    if (!refreshed) throw new Error("refreshed search input missing");
    expect(refreshed).not.toBe(input);
    expect(refreshed?.value).toBe("unfinished search");
    expect(doc.activeElement).toBe(refreshed);
    expect(refreshed?.selectionStart).toBe(3);
    expect(refreshed?.selectionEnd).toBe(8);
    expect(refreshed?.selectionDirection).toBe("backward");
    expect(doc.root.textContent).not.toContain("Search results (");
  } finally {
    controller.dispose();
  }
});

test.each(["pending", "running"] as const)(
  "auto-refresh: a selected %s task reaches completed without user input or mutations",
  async (status) => {
    const fixture = await loadFixtureData();
    const task = fixture.tasks.find((task) => task.status === status);
    if (!task) throw new Error("fixture missing task");
    let data = { ...fixture, tasks: [task] };
    const calls: RecordedCall[] = [];
    const delegate = fakeBridge(data, calls);
    const bridge = {
      ...delegate,
      "tasks.list": async () => fakeBridge(data, calls)["tasks.list"]({}),
      "tasks.inspect": async (params) =>
        fakeBridge(data, calls)["tasks.inspect"](params),
    } satisfies ShellBridge;
    const doc = new MiniDocument();
    const timers = fakeTimers();
    const controller = createController(
      bridge,
      doc,
      doc.root,
      undefined,
      timers,
    );
    try {
      await controller.load();
      expect(timers.delays).toEqual([3000]);
      data = { ...fixture, tasks: [{ ...task, status: "completed" }] };
      timers.advance(2999);
      expect(
        calls.filter((call) => call.method === "tasks.inspect"),
      ).toHaveLength(1);
      timers.advance(1);
      await controller.settled();
      expect(serialize(doc.root)).toContain("✔ completed");
      expect(
        calls.filter((call) => call.method === "tasks.inspect"),
      ).toHaveLength(2);
      expect(timers.count).toBe(0);
      expect(
        calls.every((call) => READ_METHODS.includes(call.method as never)),
      ).toBe(true);
    } finally {
      controller.dispose();
    }
  },
);

test("auto-refresh: disconnects back off to 30 seconds and recovery resets the cadence", async () => {
  const fixture = await loadFixtureData();
  const delegate = fakeBridge(fixture);
  let disconnected = false;
  let descriptions = 0;
  const bridge: ShellBridge = {
    ...delegate,
    "workbench.describe": async (params) => {
      descriptions++;
      if (disconnected)
        return {
          ok: false,
          error: { kind: "unavailable", message: "Workbench is unavailable." },
        };
      return delegate["workbench.describe"](params);
    },
  };
  const doc = new MiniDocument();
  const timers = fakeTimers();
  const controller = createController(bridge, doc, doc.root, undefined, timers);
  try {
    await controller.load();
    disconnected = true;
    for (const delay of [3000, 6000, 12000, 24000, 30000]) {
      const before = descriptions;
      timers.advance(delay - 1);
      expect(descriptions).toBe(before);
      timers.advance(1);
      await controller.settled();
      expect(descriptions).toBe(before + 1);
    }
    expect(timers.delays).toEqual([3000, 6000, 12000, 24000, 30000, 30000]);
    expect(doc.root.textContent).toContain("Workbench is unavailable.");
    disconnected = false;
    timers.advance(30000);
    await controller.settled();
    expect(doc.root.textContent).toContain("Connected");
    expect(timers.delays.at(-1)).toBe(3000);
  } finally {
    controller.dispose();
  }
});

test("auto-refresh: terminal or empty selections never poll and selecting a terminal task cancels a pending timer", async () => {
  const fixture = await loadFixtureData();
  const terminalTasks = fixture.tasks.filter(
    (task) => task.status !== "pending" && task.status !== "running",
  );
  for (const tasks of [[], ...terminalTasks.map((task) => [task])]) {
    const doc = new MiniDocument();
    const timers = fakeTimers();
    const controller = createController(
      fakeBridge({ ...fixture, tasks }),
      doc,
      doc.root,
      undefined,
      timers,
    );
    await controller.load();
    expect(timers.count).toBe(0);
    controller.dispose();
  }
  const doc = new MiniDocument();
  const timers = fakeTimers();
  const controller = createController(
    fakeBridge(fixture),
    doc,
    doc.root,
    undefined,
    timers,
  );
  try {
    await controller.load();
    expect(timers.count).toBe(1);
    findAll(
      doc.root,
      (element) =>
        element.tagName === "BUTTON" &&
        element.getAttribute("data-task-id") === "fixture-completed-verified",
    )[0]?.click();
    expect(timers.count).toBe(0);
    await controller.settled();
    expect(timers.count).toBe(0);
    expect(timers.delays).toEqual([3000]);
  } finally {
    controller.dispose();
  }
});

test("auto-refresh: disposal cancels timers and cannot rearm after an in-flight load", async () => {
  const fixture = await loadFixtureData();
  const delegate = fakeBridge(fixture);
  let inspections = 0;
  let defer = false;
  const started = Promise.withResolvers<void>();
  const pending =
    Promise.withResolvers<Awaited<ReturnType<ShellBridge["tasks.inspect"]>>>();
  const bridge: ShellBridge = {
    ...delegate,
    "tasks.inspect": (params) => {
      inspections++;
      if (!defer) return delegate["tasks.inspect"](params);
      started.resolve();
      return pending.promise;
    },
  };
  const doc = new MiniDocument();
  const timers = fakeTimers();
  const controller = createController(bridge, doc, doc.root, undefined, timers);
  await controller.load();
  expect(timers.count).toBe(1);
  defer = true;
  const loading = controller.load();
  await started.promise;
  expect(timers.count).toBe(0);
  timers.advance(30000);
  expect(inspections).toBe(2);
  controller.dispose();
  pending.resolve(
    await delegate["tasks.inspect"]({ task_id: "fixture-running" }),
  );
  await loading;
  await controller.load();
  timers.advance(30000);
  expect(timers.count).toBe(0);
  expect(inspections).toBe(2);
  expect(timers.delays).toEqual([3000]);

  const idle = createController(delegate, doc, doc.root, undefined, timers);
  await idle.load();
  expect(timers.count).toBe(1);
  idle.dispose();
  expect(timers.count).toBe(0);
});
