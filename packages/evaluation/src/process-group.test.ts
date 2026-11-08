import { expect, test } from "bun:test";
import { KILL_GRACE_MS, killProcessGroup } from "./process-group";

const MISSING_PGID = 2 ** 30;

test("kill grace stays at 5000 ms", () => {
  expect(KILL_GRACE_MS).toBe(5000);
});

test("a missing process group without fallback is not escalated", () => {
  expect(killProcessGroup(MISSING_PGID)).toBeNull();
});

test("a missing process group falls back to SIGTERM then SIGKILL", async () => {
  const signals: string[] = [];
  const escalate = killProcessGroup(MISSING_PGID, {
    graceMs: 1,
    fallback: (signal) => signals.push(signal),
  });
  expect(escalate).not.toBeNull();
  expect(signals).toEqual(["SIGTERM"]);
  await Bun.sleep(20);
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
});
