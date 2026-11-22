import { expect, test } from "bun:test";
import { createRendererRecovery } from "../src/main/renderer-recovery";

test("renderer recovery reloads crashes, caps retries, and leaves a static terminal state", () => {
  const actions: string[] = [];
  const reasons: string[] = [];
  const recover = createRendererRecovery({
    reload: () => actions.push("reload"),
    showRecovery: () => actions.push("recovery"),
    log: (reason) => reasons.push(reason),
    isClosing: () => false,
    now: () => 0,
  });
  recover("clean-exit");
  expect(actions).toEqual([]);
  for (const reason of ["crashed", "oom", "unresponsive", "crashed", "crashed"])
    recover(reason);
  expect(actions).toEqual(["reload", "reload", "reload", "recovery"]);
  expect(reasons).toEqual(["crashed", "oom", "unresponsive", "crashed"]);
});

test("renderer recovery expires the reload window and ignores shutdown or destroyed windows", () => {
  let time = 0;
  let closing = false;
  const actions: string[] = [];
  const recover = createRendererRecovery({
    reload: () => actions.push("reload"),
    showRecovery: () => actions.push("recovery"),
    log: () => {},
    isClosing: () => closing,
    now: () => time,
  });
  for (let index = 0; index < 3; index++) recover("crashed");
  time = 60_000;
  recover("crashed");
  expect(actions).toEqual(["reload", "reload", "reload", "reload"]);
  closing = true;
  recover("crashed");
  expect(actions).toHaveLength(4);
});
