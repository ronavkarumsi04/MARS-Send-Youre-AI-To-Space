import type { GitResult, GitRunner } from "./git";
import type { ResolveErrorReason } from "./schemas";

const COMMIT_PROBE_BYTES = 4096;

/** Maps a failed git invocation to its error reason; `null` when git ran to completion. */
export function gitFailure(result: GitResult): ResolveErrorReason | null {
  if (result.spawn_error) return "git_unavailable";
  if (result.timed_out) return "timeout";
  if (result.truncated) return "output_truncated";
  return null;
}

export type CommitCheck =
  | { state: "ok" }
  | { state: "unavailable" }
  | { state: "error"; reason: ResolveErrorReason };

/** Checks that `commitSha` names a commit object present in the repository at `cwd`. */
export async function verifyCommit(
  git: GitRunner,
  cwd: string,
  commitSha: string,
  timeoutMs: number,
): Promise<CommitCheck> {
  const result = await git.run({
    args: [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${commitSha}^{commit}`,
    ],
    cwd,
    timeoutMs,
    maxOutputBytes: COMMIT_PROBE_BYTES,
  });
  const reason = gitFailure(result);
  if (reason) return { state: "error", reason };
  if (
    result.exit_code !== 0 ||
    new TextDecoder("utf-8", { fatal: false }).decode(result.stdout).trim() !==
      commitSha
  )
    return { state: "unavailable" };
  return { state: "ok" };
}
