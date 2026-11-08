/** How long a process group gets to exit after SIGTERM before SIGKILL. */
export const KILL_GRACE_MS = 5000;

export interface KillProcessGroupOptions {
  graceMs?: number;
  /**
   * Called when signalling the group fails. Without it a failed SIGTERM means
   * the group is already gone and nothing is escalated.
   */
  fallback?: (signal: "SIGTERM" | "SIGKILL") => void;
}

/**
 * SIGTERMs the process group `pid`, then SIGKILLs it after `graceMs`.
 * Returns the (unref'd) escalation timer, or `null` when nothing was escalated.
 */
export function killProcessGroup(
  pid: number,
  options: KillProcessGroupOptions = {},
): ReturnType<typeof setTimeout> | null {
  const { graceMs = KILL_GRACE_MS, fallback } = options;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    if (!fallback) return null;
    fallback("SIGTERM");
  }
  const escalate = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      fallback?.("SIGKILL");
    }
  }, graceMs);
  escalate.unref();
  return escalate;
}
