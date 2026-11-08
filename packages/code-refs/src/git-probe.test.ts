import { describe, expect, test } from "bun:test";
import type { GitInvocation, GitResult, GitRunner } from "./git";
import { gitFailure, verifyCommit } from "./git-probe";

const SHA = "a".repeat(40);

function result(overrides: Partial<GitResult> = {}): GitResult {
  return {
    exit_code: 0,
    stdout: new TextEncoder().encode(`${SHA}\n`),
    stderr: "",
    timed_out: false,
    truncated: false,
    spawn_error: null,
    ...overrides,
  };
}

function stubGit(response: GitResult): GitRunner & { calls: GitInvocation[] } {
  const calls: GitInvocation[] = [];
  return {
    calls,
    run: async (invocation) => {
      calls.push(invocation);
      return response;
    },
    version: async () => "git version 2.0.0",
  };
}

describe("gitFailure", () => {
  test("maps spawn, timeout and truncation failures in that order", () => {
    expect(gitFailure(result())).toBeNull();
    expect(gitFailure(result({ exit_code: 1 }))).toBeNull();
    expect(gitFailure(result({ spawn_error: "ENOENT", timed_out: true }))).toBe(
      "git_unavailable",
    );
    expect(gitFailure(result({ timed_out: true, truncated: true }))).toBe(
      "timeout",
    );
    expect(gitFailure(result({ truncated: true }))).toBe("output_truncated");
  });
});

describe("verifyCommit", () => {
  test("runs a bounded rev-parse of the commit object", async () => {
    const git = stubGit(result());
    expect(await verifyCommit(git, "/repo", SHA, 1234)).toEqual({
      state: "ok",
    });
    expect(git.calls).toEqual([
      {
        args: [
          "rev-parse",
          "--verify",
          "--quiet",
          "--end-of-options",
          `${SHA}^{commit}`,
        ],
        cwd: "/repo",
        timeoutMs: 1234,
        maxOutputBytes: 4096,
      },
    ]);
  });

  test("a non-zero exit or a different object name is unavailable", async () => {
    expect(
      await verifyCommit(stubGit(result({ exit_code: 1 })), "/r", SHA, 1),
    ).toEqual({ state: "unavailable" });
    const other = new TextEncoder().encode(`${"b".repeat(40)}\n`);
    expect(
      await verifyCommit(stubGit(result({ stdout: other })), "/r", SHA, 1),
    ).toEqual({ state: "unavailable" });
  });

  test("git failures are errors with the shared reason", async () => {
    expect(
      await verifyCommit(stubGit(result({ timed_out: true })), "/r", SHA, 1),
    ).toEqual({ state: "error", reason: "timeout" });
    expect(
      await verifyCommit(stubGit(result({ spawn_error: "x" })), "/r", SHA, 1),
    ).toEqual({ state: "error", reason: "git_unavailable" });
  });
});
