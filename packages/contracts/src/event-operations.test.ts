import { describe, expect, test } from "bun:test";
import { EVENT_OPERATIONS } from "./index";

describe("EVENT_OPERATIONS", () => {
  test("pins the persisted tool.completed operation names", () => {
    expect(EVENT_OPERATIONS).toEqual({
      runtimeResult: "runtime.result",
      hookCompleted: "hook.completed",
      childResult: "child.result",
      watchEvidence: "watch.evidence",
      graphBuild: "graph.build",
      graphQuery: "graph.query",
    });
    expect(Object.isFrozen(EVENT_OPERATIONS)).toBe(true);
  });
});
