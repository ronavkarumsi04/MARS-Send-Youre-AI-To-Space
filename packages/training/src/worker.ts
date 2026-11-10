import { existsSync } from "node:fs";
import { TrainingError } from "./errors";
import {
  defaultWorkerPython,
  PYTHON_DIR,
  WORKER_MODULE,
  WORKER_SETUP_HINT,
  workerAvailable,
} from "./pins";
import {
  ProbeMessageSchema,
  type ProbeResult,
  type WorkerDone,
  WorkerMessageSchema,
  type WorkerStart,
  type WorkerVersions,
} from "./schemas";

export type WorkerMode = "train" | "probe";

export interface WorkerProcess {
  readonly pid: number;
  write(line: string): void;
  closeStdin(): void;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  /** SIGKILL just the direct child (used only when group signalling fails). */
  killChild(signal: "SIGTERM" | "SIGKILL"): void;
}

export interface WorkerLauncher {
  readonly id: string;
  spawn(
    mode: WorkerMode,
    env: Record<string, string>,
    cwd?: string,
  ): WorkerProcess;
}

const MAX_LINE_BYTES = 1024 * 1024;
const LOG_TAIL = 200;
/** How long a killed worker group gets between SIGTERM and SIGKILL. */
export const KILL_GRACE_MS = 5000;
export const PROBE_TIMEOUT_MS = 120_000;

/** Prefer `setsid` so the worker leads its own process group and cancel/deadline can kill every descendant. */
function setsidPath(): string | null {
  for (const candidate of ["/usr/bin/setsid", "/bin/setsid"]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function createCommandWorkerLauncher(
  argv: readonly string[],
  options: { cwd?: string; id?: string } = {},
): WorkerLauncher {
  const setsid = setsidPath();
  if (!setsid) {
    throw new TrainingError(
      "worker_unavailable",
      "setsid is required to bound the worker process group",
    );
  }
  return {
    id: options.id ?? argv.join(" "),
    spawn(mode, env, cwd) {
      const child = Bun.spawn(
        [setsid, ...argv, ...(mode === "probe" ? ["--probe"] : [])],
        {
          cwd: cwd ?? options.cwd ?? PYTHON_DIR,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env,
        },
      );
      return {
        pid: child.pid,
        write(line) {
          child.stdin.write(line);
          void child.stdin.flush();
        },
        closeStdin() {
          try {
            void child.stdin.end();
          } catch {}
        },
        stdout: child.stdout,
        stderr: child.stderr,
        exited: child.exited,
        killChild(signal) {
          try {
            child.kill(signal);
          } catch {}
        },
      };
    },
  };
}

/** `setsid python -m mars_training_worker` from the pinned venv; refuses if the venv is missing. */
export function createPythonWorkerLauncher(
  pythonPath = defaultWorkerPython(),
): WorkerLauncher {
  if (!workerAvailable(pythonPath)) {
    throw new TrainingError("worker_unavailable", WORKER_SETUP_HINT);
  }
  return createCommandWorkerLauncher([pythonPath, "-m", WORKER_MODULE], {
    cwd: PYTHON_DIR,
    id: `python:${pythonPath}`,
  });
}

/** SIGTERM the whole group, SIGKILL it after `graceMs`. */
export function killWorkerGroup(
  proc: WorkerProcess,
  graceMs = KILL_GRACE_MS,
): void {
  const signal = (sig: "SIGTERM" | "SIGKILL") => {
    try {
      process.kill(-proc.pid, sig);
    } catch {
      proc.killChild(sig);
    }
  };
  signal("SIGTERM");
  const escalate = setTimeout(() => signal("SIGKILL"), graceMs);
  escalate.unref();
  void proc.exited.finally(() => {
    // The group may outlive its leader; always finish with SIGKILL.
    setTimeout(
      () => {
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {}
      },
      Math.min(graceMs, 1000),
    ).unref();
  });
}

async function* lines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        yield buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
      if (buffer.length > MAX_LINE_BYTES)
        throw new Error("worker line exceeds 1 MiB");
    }
    if (buffer.trim()) yield buffer;
  } finally {
    reader.releaseLock();
  }
}

async function drainTail(
  stream: ReadableStream<Uint8Array>,
  tail: string[],
): Promise<void> {
  try {
    for await (const line of lines(stream)) {
      tail.push(line.slice(0, 1000));
      if (tail.length > LOG_TAIL) tail.shift();
    }
  } catch {}
}

export interface RunWorkerOutcome {
  status: "completed" | "failed" | "cancelled";
  stop: "deadline" | "cancelled" | null;
  error: { code: string; message: string } | null;
  done: WorkerDone | null;
  versions: WorkerVersions | null;
  exit_code: number | null;
  log_tail: string[];
}

export interface RunWorkerOptions {
  launcher: WorkerLauncher;
  start: WorkerStart;
  env: Record<string, string>;
  cwd?: string;
  /** Absolute epoch ms after which the worker group is killed. */
  deadlineAt: number;
  signal?: AbortSignal;
  killGraceMs?: number;
  now?: () => number;
  onReady?(versions: WorkerVersions): void | Promise<void>;
  onProgress?(step: number, loss: number): void | Promise<void>;
}

/** Runs one training worker under a wall-clock deadline; cancel and deadline kill its process group. */
export async function runTrainingWorker(
  options: RunWorkerOptions,
): Promise<RunWorkerOutcome> {
  const now = options.now ?? Date.now;
  const logTail: string[] = [];
  const remaining = options.deadlineAt - now();
  if (remaining <= 0 || options.signal?.aborted) {
    return {
      status: options.signal?.aborted ? "cancelled" : "failed",
      stop: options.signal?.aborted ? "cancelled" : "deadline",
      error: options.signal?.aborted
        ? null
        : {
            code: "deadline_exceeded",
            message: "deadline passed before start",
          },
      done: null,
      versions: null,
      exit_code: null,
      log_tail: logTail,
    };
  }
  const proc = options.launcher.spawn("train", options.env, options.cwd);
  let stop: RunWorkerOutcome["stop"] = null;
  const kill = (reason: "deadline" | "cancelled") => {
    if (stop) return;
    stop = reason;
    killWorkerGroup(proc, options.killGraceMs);
  };
  const deadline = setTimeout(() => kill("deadline"), remaining);
  const onAbort = () => kill("cancelled");
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const stderrDone = drainTail(proc.stderr, logTail);
  let done: WorkerDone | null = null;
  let versions: WorkerVersions | null = null;
  let error: RunWorkerOutcome["error"] = null;
  try {
    proc.write(`${JSON.stringify(options.start)}\n`);
    proc.closeStdin();
    for await (const line of lines(proc.stdout)) {
      if (!line.trim()) continue;
      let message: ReturnType<typeof WorkerMessageSchema.parse>;
      try {
        message = WorkerMessageSchema.parse(JSON.parse(line));
      } catch {
        error = {
          code: "worker_protocol",
          message: "worker sent an invalid protocol message",
        };
        killWorkerGroup(proc, options.killGraceMs);
        break;
      }
      if (message.type === "ready") {
        versions = message.versions;
        await options.onReady?.(message.versions);
      } else if (message.type === "progress") {
        await options.onProgress?.(message.step, message.loss);
      } else if (message.type === "done") {
        done = message;
      } else {
        error = { code: message.code, message: message.message };
      }
    }
  } catch (cause) {
    error ??= {
      code: "worker_protocol",
      message: String(cause).slice(0, 2000),
    };
    killWorkerGroup(proc, options.killGraceMs);
  }
  // The deadline and cancel stay armed until the worker has actually exited:
  // a worker can close stdout and keep running.
  const exitCode = await proc.exited;
  clearTimeout(deadline);
  options.signal?.removeEventListener("abort", onAbort);
  // Reap anything the worker left behind in its group (e.g. dataloader children).
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {}
  await Promise.race([stderrDone, Bun.sleep(1000)]);
  const base = {
    versions,
    log_tail: logTail,
    exit_code: stop ? null : exitCode,
  };
  if (stop === "cancelled")
    return { ...base, status: "cancelled", stop, error: null, done: null };
  if (stop === "deadline") {
    return {
      ...base,
      status: "failed",
      stop,
      error: {
        code: "deadline_exceeded",
        message: "wall-clock deadline exceeded; worker process group killed",
      },
      done: null,
    };
  }
  if (!error && done && exitCode === 0)
    return { ...base, status: "completed", stop: null, error: null, done };
  return {
    ...base,
    status: "failed",
    stop: null,
    error: error ?? {
      code: "worker_exited",
      message: `worker exited with code ${exitCode} before done`,
    },
    done: null,
  };
}

/** Runs `--probe` once: installed versions, CUDA visibility, CPU count. */
export async function probeWorker(
  launcher: WorkerLauncher,
  env: Record<string, string>,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  const proc = launcher.spawn("probe", env);
  proc.closeStdin();
  const timer = setTimeout(() => killWorkerGroup(proc, 1000), timeoutMs);
  void drainTail(proc.stderr, []);
  try {
    let result: ProbeResult | null = null;
    for await (const line of lines(proc.stdout)) {
      if (!line.trim()) continue;
      const parsed = ProbeMessageSchema.safeParse(JSON.parse(line));
      if (parsed.success) result = parsed.data;
    }
    const code = await proc.exited;
    if (!result || code !== 0)
      throw new TrainingError("worker_protocol", `probe failed (exit ${code})`);
    return result;
  } catch (error) {
    if (error instanceof TrainingError) throw error;
    throw new TrainingError(
      "worker_protocol",
      `probe failed: ${String(error).slice(0, 500)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}
