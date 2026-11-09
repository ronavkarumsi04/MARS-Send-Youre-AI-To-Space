import { createHash, randomUUID } from "node:crypto";
import {
  type ArtifactRef,
  ArtifactRefSchema,
  type Budget,
  exceedsUsd,
  isTerminalTaskStatus,
  type RequestContext,
  remainingUsd,
  type Task,
} from "@mars/contracts";
import { canonicalJson, RequestContextSchema } from "@mars/tasks";
import { BrowserError } from "./errors";
import {
  BROWSER_ACTION_TYPES,
  type BrowserAction,
  type BrowserPolicyAction,
  type BrowserRequest,
  BrowserRequestSchema,
  type BrowserResult,
  BrowserResultSchema,
  type BrowserStep,
  BrowserStepSchema,
  type BrowserUsage,
  BrowserUsageSchema,
} from "./schemas";
import {
  type OpenBrowserStore,
  openBrowserStore,
  sha256,
  timestamp,
} from "./store";

export type BrowserJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export type BrowserJobErrorCode =
  | "deadline_exceeded"
  | "cancelled"
  | "attempts_exhausted"
  | "worker_failed"
  | "budget_exceeded"
  | "incomplete";

export interface BrowserJob {
  request_id: string;
  task_id: string;
  task_revision: number;
  goal: string;
  start_url: string;
  allowed_actions: BrowserPolicyAction[];
  session_key: string | null;
  status: BrowserJobStatus;
  stale: boolean;
  attempts: number;
  max_attempts: number;
  submitted_at: string;
  deadline: string;
  finished_at: string | null;
  error_code: BrowserJobErrorCode | null;
  usage: BrowserUsage;
}

export interface BrowserJobView {
  job: BrowserJob;
  /** Steps of the latest attempt, in order. */
  steps: BrowserStep[];
  result: BrowserResult | null;
}

export interface BrowserWorkerInput {
  request_id: string;
  attempt: number;
  task_id: string;
  task_revision: number;
  goal: string;
  start_url: string;
  actions?: BrowserAction[];
  allowed_actions: BrowserPolicyAction[];
  max_steps: number;
  deadline: string;
  budget: Budget;
  usage: BrowserUsage;
  session_key?: string;
}

export interface BrowserEvidenceCapture {
  kind: "screenshot" | "page_text";
  url: string;
  media_type: string;
  data: Uint8Array;
}

export interface BrowserWorkerContext {
  readonly signal: AbortSignal;
  captureEvidence(capture: BrowserEvidenceCapture): Promise<ArtifactRef>;
  recordStep(step: BrowserStep): Promise<void>;
  complete(result: BrowserResult): Promise<void>;
  /** Saved storage state of the job's `session_key`, if any. */
  loadSession(): Promise<Uint8Array | null>;
  saveSession(data: Uint8Array): Promise<void>;
  reportUsage(delta: {
    input_tokens: number;
    output_tokens: number;
    cost_usd?: number | null;
  }): Promise<void>;
}

export interface BrowserWorker {
  readonly id: string;
  readonly version: string;
  run(input: BrowserWorkerInput, context: BrowserWorkerContext): Promise<void>;
}

export interface BrowserTaskReader {
  inspect(context: RequestContext, taskId: string): Promise<Task>;
}

export interface BrowserBudgetLedger {
  reserve(
    context: RequestContext,
    taskId: string,
    key: string,
    amount: { tokens: number; usd: number },
  ): Promise<void>;
  record(
    context: RequestContext,
    taskId: string,
    key: string,
    amount: { tokens: number; usd: number },
  ): Promise<void>;
  committed(
    context: RequestContext,
    taskId: string,
    excludeKey?: string,
  ): Promise<{ tokens: number; usd: number }>;
}

export interface BrowserConcurrencySlots {
  acquire(
    context: RequestContext,
    taskId: string,
    key: string,
    lease: { now: number; expiresAt: number },
  ): Promise<boolean>;
  release(context: RequestContext, taskId: string, key: string): Promise<void>;
}

export interface BrowserArtifactStore {
  put(
    context: RequestContext,
    data: Uint8Array,
    mediaType: string,
  ): Promise<ArtifactRef>;
}

export type BrowserInternalErrorSite =
  | "run_settled"
  | "execute_claim"
  | "ledger"
  | "slots"
  | "pump";

export interface BrowserServiceOptions {
  rootDir: string;
  tasks: BrowserTaskReader;
  /** When set, browser jobs hold their budget in the task's shared ledger. */
  ledger?: BrowserBudgetLedger;
  /** When set, running jobs share the task's concurrency limit. */
  slots?: BrowserConcurrencySlots;
  artifacts: BrowserArtifactStore;
  worker: BrowserWorker;
  hostPrivateRoots?: readonly string[];
  /** Operator ceiling: requests may only allow a subset of these actions. */
  allowedActions?: readonly BrowserPolicyAction[];
  maxConcurrency?: number;
  maxActivePerTask?: number;
  maxAttempts?: number;
  leaseMs?: number;
  retryBackoffMs?: number;
  maxEvidenceBytes?: number;
  maxEvidencePerAttempt?: number;
  maxSessionBytes?: number;
  pollMs?: number;
  autoStart?: boolean;
  now?: () => number;
  onInternalError?: (where: BrowserInternalErrorSite, error: unknown) => void;
}

export interface DurableBrowserService {
  submit(context: RequestContext, request: unknown): Promise<BrowserJob>;
  inspect(context: RequestContext, requestId: string): Promise<BrowserJob>;
  list(
    context: RequestContext,
    filter?: { task_id?: string },
  ): Promise<BrowserJob[]>;
  readResult(
    context: RequestContext,
    requestId: string,
  ): Promise<BrowserJobView>;
  cancel(context: RequestContext, requestId: string): Promise<BrowserJob>;
  /** Cancels active jobs and flags results of jobs bound to an older task revision. */
  markStale(
    context: RequestContext,
    taskId: string,
    revision: number,
  ): Promise<number>;
  /** Cancels active jobs of a task that reached a terminal status. */
  reconcileTask(context: RequestContext, taskId: string): Promise<void>;
  allowance(
    context: RequestContext,
    taskId: string,
  ): Promise<{ max_tokens: number; max_usd: number }>;
  pump(): Promise<void>;
  lastInternalError():
    | { where: BrowserInternalErrorSite; error: unknown; at: string }
    | undefined;
  close(options?: { drainMs?: number }): Promise<void>;
}

export const BROWSER_BUDGET_HOLD_PREFIX = "browser:";

export function browserBudgetHoldKey(idemRequestId: string): string {
  return `${BROWSER_BUDGET_HOLD_PREFIX}${createHash("sha256")
    .update(idemRequestId)
    .digest("hex")
    .slice(0, 32)}`;
}

export function isTerminalBrowserStatus(status: BrowserJobStatus): boolean {
  return status !== "queued" && status !== "running";
}

interface JobRow {
  seq: number;
  scope_key: string;
  request_id: string;
  idem_request_id: string;
  scope_json: string;
  record_json: string;
  record_sha256: string;
  task_id: string;
  task_revision: number;
  status: BrowserJobStatus;
  stale: number;
  cancel_requested: number;
  attempts: number;
  max_attempts: number;
  available_at: number;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: number | null;
  submitted_at: string;
  deadline: string;
  finished_at: string | null;
  error_code: BrowserJobErrorCode | null;
  usage_json: string;
  worker_json: string | null;
}

interface SlotRef {
  context: RequestContext;
  taskId: string;
  key: string;
}

interface LocalRun {
  key: string;
  scopeKey: string;
  requestId: string;
  token: string;
  attempt: number;
  controller: AbortController;
  heartbeat: ReturnType<typeof setInterval>;
  deadlineTimer: ReturnType<typeof setTimeout>;
  slot?: SlotRef;
  settled: Promise<void>;
}

const NOT_FOUND = "Browser request or task not found";
const MAX_TIMER_MS = 2_147_000_000;
const EVIDENCE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "text/plain"]);
const EMPTY_USAGE: BrowserUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cost_usd: null,
  reported: false,
};

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

function mapTaskError(error: unknown): BrowserError {
  const code = errorCode(error);
  if (code === "not_found") return new BrowserError("not_found", NOT_FOUND);
  if (code === "corrupt_record")
    return new BrowserError("corrupt_record", "Corrupt task record");
  if (code === "closed") return new BrowserError("closed", "Task store closed");
  if (code === "budget_exceeded")
    return new BrowserError(
      "budget_exceeded",
      "Browser budget exceeds the task's remaining allowance",
    );
  return new BrowserError("invalid_input", "Task validation failed");
}

function parseUsage(value: string): BrowserUsage {
  const parsed = BrowserUsageSchema.safeParse(JSON.parse(value));
  if (!parsed.success)
    throw new BrowserError("corrupt_record", "Corrupt usage record");
  return parsed.data;
}

function verifiedRequest(row: JobRow): BrowserRequest {
  if (sha256(row.record_json) !== row.record_sha256)
    throw new BrowserError("corrupt_record", "Corrupt browser request");
  const parsed = BrowserRequestSchema.safeParse(JSON.parse(row.record_json));
  if (!parsed.success || parsed.data.task_id !== row.task_id)
    throw new BrowserError("corrupt_record", "Corrupt browser request");
  return parsed.data;
}

/** What a job holds against the task: its whole budget while active, its usage once done. */
export function browserJobCommitment(
  budget: Budget,
  status: BrowserJobStatus,
  attempts: number,
  usage: BrowserUsage,
): { tokens: number; usd: number } {
  const used = usage.input_tokens + usage.output_tokens;
  if (!isTerminalBrowserStatus(status))
    return {
      tokens: Math.max(budget.max_tokens, used),
      usd: Math.max(budget.max_usd, usage.cost_usd ?? 0),
    };
  if (attempts === 0 && !usage.reported) return { tokens: 0, usd: 0 };
  return {
    tokens: usage.reported ? used : budget.max_tokens,
    usd:
      usage.reported && usage.cost_usd !== null
        ? usage.cost_usd
        : budget.max_usd,
  };
}

function positiveInt(
  value: number | undefined,
  fallback: number,
  name: string,
  min = 1,
) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min)
    throw new BrowserError(
      "invalid_input",
      `${name} must be an integer of at least ${min}`,
    );
  return result;
}

export async function createBrowserService(
  options: BrowserServiceOptions,
): Promise<DurableBrowserService> {
  const config = {
    maxConcurrency: positiveInt(options.maxConcurrency, 2, "maxConcurrency"),
    maxActivePerTask: positiveInt(
      options.maxActivePerTask,
      4,
      "maxActivePerTask",
    ),
    maxAttempts: positiveInt(options.maxAttempts, 2, "maxAttempts"),
    leaseMs: positiveInt(options.leaseMs, 30_000, "leaseMs"),
    retryBackoffMs: positiveInt(
      options.retryBackoffMs,
      1_000,
      "retryBackoffMs",
      0,
    ),
    maxEvidenceBytes: positiveInt(
      options.maxEvidenceBytes,
      4 * 1024 * 1024,
      "maxEvidenceBytes",
    ),
    maxEvidencePerAttempt: positiveInt(
      options.maxEvidencePerAttempt,
      32,
      "maxEvidencePerAttempt",
    ),
    maxSessionBytes: positiveInt(
      options.maxSessionBytes,
      1024 * 1024,
      "maxSessionBytes",
    ),
    pollMs: positiveInt(options.pollMs, 250, "pollMs"),
    autoStart: options.autoStart ?? true,
    now: options.now ?? Date.now,
  };
  const ceiling = new Set<BrowserPolicyAction>(
    options.allowedActions ?? BROWSER_ACTION_TYPES,
  );
  for (const action of ceiling)
    if (!(BROWSER_ACTION_TYPES as readonly string[]).includes(action))
      throw new BrowserError("invalid_input", "Unknown allowed action");
  const store: OpenBrowserStore = openBrowserStore({
    rootDir: options.rootDir,
    ...(options.hostPrivateRoots
      ? { hostPrivateRoots: options.hostPrivateRoots }
      : {}),
  });
  const { db } = store;
  const privateRoots = [...store.privateRoots, store.rootDir].sort(
    (a, b) => b.length - a.length,
  );
  const containsPrivate = (text: string) =>
    privateRoots.some((root) => text.includes(root));
  const scrub = (text: string) =>
    privateRoots.reduce(
      (out, root) => out.split(root).join("[redacted]"),
      text,
    );
  if (
    containsPrivate(options.worker.id) ||
    containsPrivate(options.worker.version)
  )
    throw new BrowserError(
      "invalid_input",
      "Worker identity names a private path",
    );

  const instanceId = randomUUID();
  const localRuns = new Map<string, LocalRun>();
  let state: "open" | "closing" | "closed" = "open";
  let pumping = false;
  let lastError:
    | { where: BrowserInternalErrorSite; error: unknown; at: string }
    | undefined;
  const now = () => config.now();
  const immediate = <T>(operation: () => T): T =>
    db.transaction(operation).immediate();
  const reportInternalError = (
    where: BrowserInternalErrorSite,
    error: unknown,
  ) => {
    lastError = { where, error, at: timestamp(now()) };
    try {
      options.onInternalError?.(where, error);
    } catch {}
  };
  const checkOpen = () => {
    if (state !== "open")
      throw new BrowserError("closed", "Browser service is closed");
  };
  const parseContext = (value: unknown) => {
    const parsed = RequestContextSchema.safeParse(value);
    if (!parsed.success)
      throw new BrowserError("invalid_input", "Invalid request context");
    const scopeJson = canonicalJson(parsed.data.scope);
    return { context: parsed.data, scopeJson, scopeKey: sha256(scopeJson) };
  };
  const internalContext = (row: JobRow, suffix: string): RequestContext => ({
    schema_version: 1,
    scope: JSON.parse(row.scope_json) as RequestContext["scope"],
    request_id: `browser:${row.request_id}:${suffix}`,
  });
  const findRow = (scopeKey: string, requestId: string): JobRow => {
    const row = db
      .query("SELECT * FROM jobs WHERE scope_key = ? AND request_id = ?")
      .get(scopeKey, requestId) as JobRow | null;
    if (!row) throw new BrowserError("not_found", NOT_FOUND);
    return row;
  };
  const toJob = (row: JobRow): BrowserJob => {
    const request = verifiedRequest(row);
    return {
      request_id: row.request_id,
      task_id: row.task_id,
      task_revision: row.task_revision,
      goal: request.goal,
      start_url: request.start_url,
      allowed_actions: request.allowed_actions,
      session_key: request.session_key ?? null,
      status: row.status,
      stale: row.stale === 1,
      attempts: row.attempts,
      max_attempts: row.max_attempts,
      submitted_at: row.submitted_at,
      deadline: row.deadline,
      finished_at: row.finished_at,
      error_code: row.error_code,
      usage: parseUsage(row.usage_json),
    };
  };
  const commitmentOf = (row: JobRow) =>
    browserJobCommitment(
      verifiedRequest(row).budget,
      row.status,
      row.attempts,
      parseUsage(row.usage_json),
    );

  /** Mirrors each job's current commitment into the task ledger. */
  const syncHolds = async (rows: readonly JobRow[]): Promise<void> => {
    const ledger = options.ledger;
    if (!ledger) return;
    for (const row of rows) {
      try {
        await ledger.record(
          internalContext(row, "hold"),
          row.task_id,
          browserBudgetHoldKey(row.idem_request_id),
          commitmentOf(row),
        );
      } catch (error) {
        reportInternalError("ledger", error);
      }
    }
  };
  const syncHoldOf = (scopeKey: string, requestId: string) => {
    if (state === "closed") return Promise.resolve();
    const row = db
      .query("SELECT * FROM jobs WHERE scope_key = ? AND request_id = ?")
      .get(scopeKey, requestId) as JobRow | null;
    return row ? syncHolds([row]) : Promise.resolve();
  };

  const finishRow = (
    entry: LocalRun,
    status: BrowserJobStatus,
    code: BrowserJobErrorCode | null,
  ): boolean =>
    immediate(
      () =>
        db
          .query(
            `UPDATE jobs SET status = ?, error_code = ?, finished_at = ?,
               lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
             WHERE scope_key = ? AND request_id = ? AND lease_token = ?
               AND status = 'running'`,
          )
          .run(
            status,
            code,
            timestamp(now()),
            entry.scopeKey,
            entry.requestId,
            entry.token,
          ).changes === 1,
    );

  const markExpired = (entry: LocalRun): void => {
    if (state === "closed" || entry.controller.signal.aborted) return;
    const row = db
      .query(
        "SELECT deadline FROM jobs WHERE scope_key = ? AND request_id = ? AND lease_token = ?",
      )
      .get(entry.scopeKey, entry.requestId, entry.token) as {
      deadline: string;
    } | null;
    if (!row) return;
    const remaining = Date.parse(row.deadline) - now();
    if (remaining > 0) {
      clearTimeout(entry.deadlineTimer);
      entry.deadlineTimer = setTimeout(
        () => markExpired(entry),
        Math.min(MAX_TIMER_MS, remaining),
      );
      entry.deadlineTimer.unref?.();
      return;
    }
    finishRow(entry, "expired", "deadline_exceeded");
    entry.controller.abort("deadline_exceeded");
  };

  const abortForRowState = (entry: LocalRun): void => {
    if (entry.controller.signal.aborted || state === "closed") return;
    const row = db
      .query("SELECT * FROM jobs WHERE scope_key = ? AND request_id = ?")
      .get(entry.scopeKey, entry.requestId) as JobRow | null;
    if (!row) entry.controller.abort("lease_lost");
    else if (row.cancel_requested === 1 || row.status === "cancelled")
      entry.controller.abort("cancelled");
    else if (row.error_code === "budget_exceeded")
      entry.controller.abort("budget_exceeded");
    else if (row.status === "expired" || now() >= Date.parse(row.deadline))
      entry.controller.abort("deadline_exceeded");
    else entry.controller.abort("lease_lost");
  };

  const requeue = (entry: LocalRun, attempts?: number) =>
    immediate(() =>
      db
        .query(
          `UPDATE jobs SET status = 'queued', attempts = COALESCE(?, attempts),
             lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
           WHERE scope_key = ? AND request_id = ? AND lease_token = ?
             AND status = 'running'`,
        )
        .run(attempts ?? null, entry.scopeKey, entry.requestId, entry.token),
    );

  const heartbeat = (entry: LocalRun): void => {
    if (state === "closed" || entry.controller.signal.aborted) return;
    const row = db
      .query(
        "SELECT deadline FROM jobs WHERE scope_key = ? AND request_id = ? AND lease_token = ?",
      )
      .get(entry.scopeKey, entry.requestId, entry.token) as {
      deadline: string;
    } | null;
    if (!row) {
      abortForRowState(entry);
      return;
    }
    if (now() >= Date.parse(row.deadline)) {
      markExpired(entry);
      return;
    }
    const renewed = immediate(() =>
      db
        .query(
          `UPDATE jobs SET lease_expires_at = ?
           WHERE scope_key = ? AND request_id = ? AND lease_token = ?
             AND status = 'running' AND lease_expires_at > ?
             AND cancel_requested = 0`,
        )
        .run(
          now() + config.leaseMs,
          entry.scopeKey,
          entry.requestId,
          entry.token,
          now(),
        ),
    );
    if (renewed.changes !== 1) {
      abortForRowState(entry);
      return;
    }
    const slot = entry.slot;
    if (slot && options.slots) {
      const at = now();
      void options.slots
        .acquire(slot.context, slot.taskId, slot.key, {
          now: at,
          expiresAt: at + config.leaseMs,
        })
        .then((held) => {
          // A run whose slot lapsed and was taken stops and goes back to the queue.
          if (held || entry.controller.signal.aborted || state === "closed")
            return;
          requeue(entry);
          entry.controller.abort("lease_lost");
        })
        .catch((error: unknown) => reportInternalError("slots", error));
    }
  };

  const workerGuard = (entry: LocalRun): JobRow => {
    if (state === "closed")
      throw new BrowserError("lease_lost", "Browser worker lease was lost");
    const row = db
      .query("SELECT * FROM jobs WHERE scope_key = ? AND request_id = ?")
      .get(entry.scopeKey, entry.requestId) as JobRow | null;
    if (!row)
      throw new BrowserError("lease_lost", "Browser worker lease was lost");
    if (row.cancel_requested === 1 || row.status === "cancelled")
      throw new BrowserError("cancelled", "Browser request was cancelled");
    if (row.error_code === "budget_exceeded")
      throw new BrowserError("budget_exceeded", "Browser budget exceeded");
    if (row.status === "expired" || now() >= Date.parse(row.deadline))
      throw new BrowserError("deadline_exceeded", "Browser deadline exceeded");
    if (
      row.lease_token !== entry.token ||
      row.status !== "running" ||
      row.lease_expires_at === null ||
      row.lease_expires_at <= now() ||
      entry.controller.signal.aborted
    )
      throw new BrowserError("lease_lost", "Browser worker lease was lost");
    return row;
  };
  const guarded = <T>(entry: LocalRun, operation: (row: JobRow) => T): T =>
    immediate(() => operation(workerGuard(entry)));

  const capturedRefs = (entry: LocalRun): Map<string, string> => {
    const rows = db
      .query(
        "SELECT artifact_id, ref_json FROM evidence WHERE scope_key = ? AND request_id = ? AND attempt = ?",
      )
      .all(entry.scopeKey, entry.requestId, entry.attempt) as Array<{
      artifact_id: string;
      ref_json: string;
    }>;
    return new Map(rows.map((row) => [row.artifact_id, row.ref_json]));
  };
  const assertCaptured = (entry: LocalRun, refs: readonly ArtifactRef[]) => {
    const captured = capturedRefs(entry);
    for (const ref of refs) {
      if (captured.get(ref.artifact_id) !== canonicalJson(ref))
        throw new BrowserError(
          "evidence_rejected",
          "Artifacts must be evidence captured by this attempt",
        );
    }
  };

  const workerContext = (
    entry: LocalRun,
    row: JobRow,
    request: BrowserRequest,
  ): BrowserWorkerContext => {
    const context = internalContext(row, "worker");
    const allowed = new Set<string>([...request.allowed_actions, "done"]);
    const sessionKey = request.session_key;
    return {
      signal: entry.controller.signal,
      async captureEvidence(capture) {
        workerGuard(entry);
        if (
          !capture ||
          (capture.kind !== "screenshot" && capture.kind !== "page_text") ||
          !(capture.data instanceof Uint8Array) ||
          typeof capture.url !== "string" ||
          capture.url.length > 2048 ||
          !EVIDENCE_MEDIA_TYPES.has(capture.media_type) ||
          (capture.kind === "page_text") !==
            (capture.media_type === "text/plain")
        )
          throw new BrowserError("invalid_input", "Invalid evidence capture");
        if (capture.data.byteLength > config.maxEvidenceBytes)
          throw new BrowserError("evidence_rejected", "Evidence is too large");
        if (capturedRefs(entry).size >= config.maxEvidencePerAttempt)
          throw new BrowserError("evidence_rejected", "Too much evidence");
        if (
          containsPrivate(capture.url) ||
          (capture.kind === "page_text" &&
            containsPrivate(new TextDecoder().decode(capture.data)))
        )
          throw new BrowserError(
            "evidence_rejected",
            "Evidence names a private path",
          );
        const ref = ArtifactRefSchema.parse(
          await options.artifacts.put(
            context,
            capture.data,
            capture.media_type,
          ),
        );
        guarded(entry, () => {
          db.query(
            `INSERT OR IGNORE INTO evidence
               (scope_key, request_id, attempt, artifact_id, ref_json, kind, url)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            entry.scopeKey,
            entry.requestId,
            entry.attempt,
            ref.artifact_id,
            canonicalJson(ref),
            capture.kind,
            capture.url,
          );
        });
        return ref;
      },
      async recordStep(input) {
        const parsed = BrowserStepSchema.safeParse(input);
        if (!parsed.success)
          throw new BrowserError("invalid_input", "Invalid browser step");
        const step: BrowserStep = {
          ...parsed.data,
          detail: scrub(parsed.data.detail),
          url: scrub(parsed.data.url),
          title: scrub(parsed.data.title),
        };
        if (step.outcome !== "blocked" && !allowed.has(step.action.type))
          throw new BrowserError(
            "forbidden",
            "Step action is not allowed by the request policy",
          );
        if (step.index > request.max_steps)
          throw new BrowserError(
            "budget_exceeded",
            "Browser step limit reached",
          );
        guarded(entry, () => {
          assertCaptured(entry, step.artifacts);
          const inserted = db
            .query(
              `INSERT OR IGNORE INTO steps
                 (scope_key, request_id, attempt, step_index, step_json)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
              entry.scopeKey,
              entry.requestId,
              entry.attempt,
              step.index,
              canonicalJson(step),
            );
          if (inserted.changes !== 1)
            throw new BrowserError("conflict", "Step index already recorded");
        });
      },
      async complete(input) {
        const parsed = BrowserResultSchema.safeParse(input);
        if (!parsed.success)
          throw new BrowserError("invalid_input", "Invalid browser result");
        const result: BrowserResult = {
          ...parsed.data,
          summary: scrub(parsed.data.summary),
          final_url: scrub(parsed.data.final_url),
          ...(parsed.data.extracted !== undefined
            ? { extracted: scrub(parsed.data.extracted) }
            : {}),
        };
        guarded(entry, () => {
          assertCaptured(entry, result.artifacts);
          const existing = db
            .query(
              "SELECT attempt FROM results WHERE scope_key = ? AND request_id = ?",
            )
            .get(entry.scopeKey, entry.requestId) as { attempt: number } | null;
          if (existing?.attempt === entry.attempt)
            throw new BrowserError("conflict", "Result already recorded");
          db.query(
            `INSERT OR REPLACE INTO results (scope_key, request_id, attempt, result_json)
             VALUES (?, ?, ?, ?)`,
          ).run(
            entry.scopeKey,
            entry.requestId,
            entry.attempt,
            canonicalJson(result),
          );
        });
      },
      async loadSession() {
        const current = workerGuard(entry);
        if (!sessionKey) return null;
        const saved = db
          .query(
            "SELECT data FROM sessions WHERE scope_key = ? AND task_id = ? AND session_key = ?",
          )
          .get(entry.scopeKey, current.task_id, sessionKey) as {
          data: Uint8Array;
        } | null;
        return saved ? new Uint8Array(saved.data) : null;
      },
      async saveSession(data) {
        if (!sessionKey)
          throw new BrowserError("forbidden", "Job has no session key");
        if (
          !(data instanceof Uint8Array) ||
          data.byteLength > config.maxSessionBytes
        )
          throw new BrowserError("invalid_input", "Invalid session state");
        guarded(entry, (current) => {
          db.query(
            `INSERT OR REPLACE INTO sessions (scope_key, task_id, session_key, data, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
          ).run(
            entry.scopeKey,
            current.task_id,
            sessionKey,
            data,
            timestamp(now()),
          );
        });
      },
      // Usage is recorded even after the lease is lost: it may already be billed.
      async reportUsage(delta) {
        const input = delta?.input_tokens;
        const output = delta?.output_tokens;
        const cost = delta?.cost_usd ?? null;
        if (
          !Number.isSafeInteger(input) ||
          !Number.isSafeInteger(output) ||
          input < 0 ||
          output < 0 ||
          (cost !== null && (!Number.isFinite(cost) || cost < 0))
        )
          throw new BrowserError("invalid_input", "Invalid usage delta");
        if (state === "closed") return;
        const over = immediate(() => {
          const current = db
            .query("SELECT * FROM jobs WHERE scope_key = ? AND request_id = ?")
            .get(entry.scopeKey, entry.requestId) as JobRow | null;
          if (!current) return false;
          const usage = parseUsage(current.usage_json);
          const next: BrowserUsage = {
            input_tokens: usage.input_tokens + input,
            output_tokens: usage.output_tokens + output,
            cost_usd:
              cost === null && usage.cost_usd === null
                ? null
                : (usage.cost_usd ?? 0) + (cost ?? 0),
            reported: true,
          };
          db.query(
            "UPDATE jobs SET usage_json = ? WHERE scope_key = ? AND request_id = ?",
          ).run(JSON.stringify(next), entry.scopeKey, entry.requestId);
          const exceeded =
            next.input_tokens + next.output_tokens >
              request.budget.max_tokens ||
            (next.cost_usd !== null &&
              exceedsUsd(next.cost_usd, request.budget.max_usd));
          if (!exceeded) return false;
          db.query(
            `UPDATE jobs SET status = 'failed', error_code = 'budget_exceeded',
               finished_at = ?, lease_owner = NULL, lease_token = NULL,
               lease_expires_at = NULL
             WHERE scope_key = ? AND request_id = ? AND lease_token = ?
               AND status = 'running'`,
          ).run(timestamp(now()), entry.scopeKey, entry.requestId, entry.token);
          return true;
        });
        await syncHoldOf(entry.scopeKey, entry.requestId);
        if (over) {
          entry.controller.abort("budget_exceeded");
          throw new BrowserError("budget_exceeded", "Browser budget exceeded");
        }
      },
    };
  };

  const finishSuccess = (entry: LocalRun): void => {
    if (state === "closed" || entry.controller.signal.aborted) return;
    const result = db
      .query(
        "SELECT attempt FROM results WHERE scope_key = ? AND request_id = ? AND attempt = ?",
      )
      .get(entry.scopeKey, entry.requestId, entry.attempt);
    const row = db
      .query(
        "SELECT deadline FROM jobs WHERE scope_key = ? AND request_id = ? AND lease_token = ?",
      )
      .get(entry.scopeKey, entry.requestId, entry.token) as {
      deadline: string;
    } | null;
    if (!row) return;
    if (now() >= Date.parse(row.deadline)) {
      markExpired(entry);
      return;
    }
    if (result) finishRow(entry, "completed", null);
    else finishRow(entry, "failed", "incomplete");
  };

  const finishFailure = (entry: LocalRun, error: unknown): void => {
    if (state === "closed" || entry.controller.signal.aborted) return;
    immediate(() => {
      const row = db
        .query(
          "SELECT * FROM jobs WHERE scope_key = ? AND request_id = ? AND lease_token = ?",
        )
        .get(entry.scopeKey, entry.requestId, entry.token) as JobRow | null;
      if (
        !row ||
        row.status !== "running" ||
        row.lease_expires_at === null ||
        row.lease_expires_at <= now()
      )
        return;
      if (!(error instanceof BrowserError) && row.attempts < row.max_attempts) {
        db.query(
          `UPDATE jobs SET status = 'queued', available_at = ?, lease_owner = NULL,
             lease_token = NULL, lease_expires_at = NULL
           WHERE scope_key = ? AND request_id = ? AND lease_token = ?`,
        ).run(
          now() + config.retryBackoffMs * row.attempts,
          entry.scopeKey,
          entry.requestId,
          entry.token,
        );
        return;
      }
      const code: BrowserJobErrorCode =
        error instanceof BrowserError
          ? error.code === "budget_exceeded"
            ? "budget_exceeded"
            : error.code === "deadline_exceeded"
              ? "deadline_exceeded"
              : "worker_failed"
          : "attempts_exhausted";
      db.query(
        `UPDATE jobs SET status = 'failed', error_code = ?, finished_at = ?,
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
         WHERE scope_key = ? AND request_id = ? AND lease_token = ?`,
      ).run(
        code,
        timestamp(now()),
        entry.scopeKey,
        entry.requestId,
        entry.token,
      );
    });
  };

  // Keyed per attempt, so a stale attempt never renews or frees its successor's.
  const slotFor = (row: JobRow, attempt: number): SlotRef => ({
    context: internalContext(row, "slot"),
    taskId: row.task_id,
    key: `${browserBudgetHoldKey(row.idem_request_id)}:${attempt}`,
  });

  interface Claim {
    row: JobRow;
    request: BrowserRequest;
    token: string;
    attempt: number;
  }

  const expireOverdue = () =>
    db
      .query(
        `UPDATE jobs SET status = 'expired', error_code = 'deadline_exceeded',
           finished_at = ?, lease_owner = NULL, lease_token = NULL,
           lease_expires_at = NULL
         WHERE status IN ('queued', 'running') AND deadline <= ?`,
      )
      .run(timestamp(now()), timestamp(now()));

  const claimNext = (skip: ReadonlySet<string>): Claim | null =>
    immediate(() => {
      const at = now();
      expireOverdue();
      const candidates = db
        .query(
          `SELECT * FROM jobs
           WHERE (status = 'queued' AND cancel_requested = 0 AND available_at <= ?)
              OR (status = 'running' AND lease_expires_at <= ?)
           ORDER BY seq`,
        )
        .all(at, at) as JobRow[];
      for (const candidate of candidates) {
        const key = `${candidate.scope_key}\n${candidate.request_id}`;
        if (localRuns.has(key) || skip.has(key)) continue;
        let request: BrowserRequest;
        try {
          request = verifiedRequest(candidate);
        } catch {
          db.query(
            `UPDATE jobs SET status = 'failed', error_code = 'worker_failed',
               finished_at = ?, lease_owner = NULL, lease_token = NULL,
               lease_expires_at = NULL WHERE seq = ?`,
          ).run(timestamp(at), candidate.seq);
          continue;
        }
        if (candidate.attempts >= candidate.max_attempts) {
          db.query(
            `UPDATE jobs SET status = 'failed', error_code = 'attempts_exhausted',
               finished_at = ?, lease_owner = NULL, lease_token = NULL,
               lease_expires_at = NULL WHERE seq = ?`,
          ).run(timestamp(at), candidate.seq);
          continue;
        }
        const token = randomUUID();
        const attempt = candidate.attempts + 1;
        const workerJson = JSON.stringify({
          id: options.worker.id,
          version: options.worker.version,
        });
        db.query(
          `UPDATE jobs SET status = 'running', attempts = ?, lease_owner = ?,
             lease_token = ?, lease_expires_at = ?, worker_json = ?
           WHERE seq = ?`,
        ).run(
          attempt,
          instanceId,
          token,
          at + config.leaseMs,
          workerJson,
          candidate.seq,
        );
        return {
          row: { ...candidate, status: "running", attempts: attempt },
          request,
          token,
          attempt,
        };
      }
      return null;
    });

  // A job the task has no free slot for goes back to the queue unchanged.
  const admitSlot = async (claim: Claim): Promise<boolean> => {
    if (!options.slots) return true;
    const slot = slotFor(claim.row, claim.attempt);
    const at = now();
    const admitted = await options.slots
      .acquire(slot.context, slot.taskId, slot.key, {
        now: at,
        expiresAt: at + config.leaseMs,
      })
      .catch((error: unknown) => {
        reportInternalError("slots", error);
        return false;
      });
    if (admitted) return true;
    if (state !== "closed")
      immediate(() =>
        db
          .query(
            `UPDATE jobs SET status = 'queued', attempts = ?, lease_owner = NULL,
               lease_token = NULL, lease_expires_at = NULL
             WHERE seq = ? AND lease_token = ? AND status = 'running'`,
          )
          .run(claim.attempt - 1, claim.row.seq, claim.token),
      );
    return false;
  };

  const executeClaim = (claim: Claim): void => {
    const key = `${claim.row.scope_key}\n${claim.row.request_id}`;
    const entry: LocalRun = {
      key,
      scopeKey: claim.row.scope_key,
      requestId: claim.row.request_id,
      token: claim.token,
      attempt: claim.attempt,
      controller: new AbortController(),
      heartbeat: setInterval(
        () => heartbeat(entry),
        Math.max(10, Math.floor(config.leaseMs / 3)),
      ),
      deadlineTimer: setTimeout(
        () => markExpired(entry),
        Math.max(
          0,
          Math.min(MAX_TIMER_MS, Date.parse(claim.row.deadline) - now()),
        ),
      ),
      settled: Promise.resolve(),
      ...(options.slots ? { slot: slotFor(claim.row, claim.attempt) } : {}),
    };
    entry.heartbeat.unref?.();
    entry.deadlineTimer.unref?.();
    localRuns.set(key, entry);
    const { request } = claim;
    const input: BrowserWorkerInput = {
      request_id: claim.row.request_id,
      attempt: claim.attempt,
      task_id: request.task_id,
      task_revision: request.task_revision,
      goal: request.goal,
      start_url: request.start_url,
      ...(request.actions ? { actions: request.actions } : {}),
      allowed_actions: request.allowed_actions,
      max_steps: request.max_steps,
      deadline: claim.row.deadline,
      budget: request.budget,
      usage: parseUsage(claim.row.usage_json),
      ...(request.session_key ? { session_key: request.session_key } : {}),
    };
    const run = Promise.resolve().then(() =>
      options.worker.run(input, workerContext(entry, claim.row, request)),
    );
    const release = async (): Promise<void> => {
      clearInterval(entry.heartbeat);
      clearTimeout(entry.deadlineTimer);
      localRuns.delete(key);
      const slot = entry.slot;
      if (slot && options.slots)
        await options.slots
          .release(slot.context, slot.taskId, slot.key)
          .catch((error: unknown) => reportInternalError("slots", error));
      await syncHoldOf(entry.scopeKey, entry.requestId);
      schedulePump();
    };
    entry.settled = run
      .then(
        () => finishSuccess(entry),
        (error: unknown) => finishFailure(entry, error),
      )
      .catch((error: unknown) => reportInternalError("run_settled", error))
      .then(release);
  };

  const pump = async (): Promise<void> => {
    if (state !== "open" || pumping) return;
    pumping = true;
    try {
      immediate(expireOverdue);
      const refused = new Set<string>();
      while (localRuns.size < config.maxConcurrency && state === "open") {
        const claim = claimNext(refused);
        if (!claim) break;
        if (!(await admitSlot(claim))) {
          refused.add(`${claim.row.scope_key}\n${claim.row.request_id}`);
          continue;
        }
        if (state !== "open") break;
        executeClaim(claim);
      }
    } finally {
      pumping = false;
    }
  };
  const schedulePump = () => {
    if (!config.autoStart || state !== "open") return;
    queueMicrotask(() => {
      void pump().catch((error: unknown) => reportInternalError("pump", error));
    });
  };
  const poller = config.autoStart
    ? setInterval(schedulePump, config.pollMs)
    : undefined;
  poller?.unref?.();

  const cancelRows = (scopeKey: string, where: string, ...args: unknown[]) => {
    const affected = immediate(() => {
      const rows = db
        .query(
          `SELECT * FROM jobs WHERE scope_key = ? AND status IN ('queued', 'running') AND ${where}`,
        )
        .all(scopeKey, ...(args as string[])) as JobRow[];
      for (const row of rows)
        db.query(
          `UPDATE jobs SET status = 'cancelled', error_code = 'cancelled',
             cancel_requested = 1, finished_at = ?, lease_owner = NULL,
             lease_token = NULL, lease_expires_at = NULL
           WHERE seq = ?`,
        ).run(timestamp(now()), row.seq);
      return rows;
    });
    for (const row of affected) {
      localRuns
        .get(`${row.scope_key}\n${row.request_id}`)
        ?.controller.abort("cancelled");
    }
    return affected;
  };
  const taskRows = (scopeKey: string, taskId: string) =>
    db
      .query("SELECT * FROM jobs WHERE scope_key = ? AND task_id = ?")
      .all(scopeKey, taskId) as JobRow[];

  const inspectTask = async (context: RequestContext, taskId: unknown) => {
    if (
      typeof taskId !== "string" ||
      taskId.length === 0 ||
      taskId.length > 256
    )
      throw new BrowserError("invalid_input", "Invalid task id");
    try {
      return await options.tasks.inspect(context, taskId);
    } catch (error) {
      throw mapTaskError(error);
    }
  };

  // Restore holds for jobs persisted by an earlier process.
  await syncHolds(db.query("SELECT * FROM jobs").all() as JobRow[]);
  schedulePump();

  return {
    async submit(contextInput, requestInput) {
      checkOpen();
      const { context, scopeJson, scopeKey } = parseContext(contextInput);
      const parsed = BrowserRequestSchema.safeParse(requestInput);
      if (!parsed.success)
        throw new BrowserError("invalid_input", "Invalid browser request");
      const request = parsed.data;
      for (const action of request.allowed_actions)
        if (!ceiling.has(action))
          throw new BrowserError(
            "forbidden",
            `Browser action '${action}' is disabled by host policy`,
          );
      const recordJson = canonicalJson(request);
      const recordSha = sha256(recordJson);
      const existing = db
        .query("SELECT * FROM jobs WHERE scope_key = ? AND idem_request_id = ?")
        .get(scopeKey, context.request_id) as JobRow | null;
      if (existing) {
        if (existing.record_sha256 !== recordSha)
          throw new BrowserError(
            "conflict",
            "Request id was already used for a different browser request",
          );
        return toJob(existing);
      }
      const task = await inspectTask(context, request.task_id);
      checkOpen();
      if (task.revision !== request.task_revision)
        throw new BrowserError("stale_revision", "Task revision is stale");
      if (isTerminalTaskStatus(task.status))
        throw new BrowserError("invalid_state", "Task is already terminal");
      for (const field of ["max_tokens", "max_usd", "max_duration_ms"] as const)
        if (request.budget[field] > task.budget[field])
          throw new BrowserError(
            "budget_exceeded",
            "Browser budget exceeds task budget",
          );
      if (options.slots && task.budget.max_concurrency < 2)
        throw new BrowserError(
          "budget_exceeded",
          "Task concurrency leaves no slot beside the foreground run",
        );
      const at = now();
      const requested = Date.parse(request.deadline);
      if (!Number.isFinite(requested) || requested <= at)
        throw new BrowserError(
          "invalid_input",
          "Browser deadline is not in the future",
        );
      const deadline = Math.min(requested, at + request.budget.max_duration_ms);
      const rows = taskRows(scopeKey, request.task_id);
      if (
        rows.filter((row) => !isTerminalBrowserStatus(row.status)).length >=
        config.maxActivePerTask
      )
        throw new BrowserError(
          "budget_exceeded",
          "Too many active browser jobs for this task",
        );
      const holdKey = browserBudgetHoldKey(context.request_id);
      const amount = {
        tokens: request.budget.max_tokens,
        usd: request.budget.max_usd,
      };
      if (options.ledger) {
        await syncHolds(rows);
        try {
          await options.ledger.reserve(
            context,
            request.task_id,
            holdKey,
            amount,
          );
        } catch (error) {
          throw mapTaskError(error);
        }
      } else {
        const committed = rows.reduce(
          (sum, row) => {
            const next = commitmentOf(row);
            return {
              tokens: sum.tokens + next.tokens,
              usd: sum.usd + next.usd,
            };
          },
          { tokens: 0, usd: 0 },
        );
        if (
          committed.tokens + amount.tokens > task.budget.max_tokens ||
          exceedsUsd(committed.usd + amount.usd, task.budget.max_usd)
        )
          throw new BrowserError(
            "budget_exceeded",
            "Browser budget exceeds the task's remaining allowance",
          );
      }
      const requestId = randomUUID();
      try {
        if (state !== "open")
          throw new BrowserError("closed", "Browser service is closed");
        immediate(() => {
          db.query(
            `INSERT INTO jobs (scope_key, request_id, idem_request_id, scope_json,
               record_json, record_sha256, task_id, task_revision, status,
               max_attempts, available_at, submitted_at, deadline, usage_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
          ).run(
            scopeKey,
            requestId,
            context.request_id,
            scopeJson,
            recordJson,
            recordSha,
            request.task_id,
            request.task_revision,
            config.maxAttempts,
            at,
            timestamp(at),
            timestamp(deadline),
            JSON.stringify(EMPTY_USAGE),
          );
        });
      } catch (error) {
        const raced = db
          .query(
            "SELECT * FROM jobs WHERE scope_key = ? AND idem_request_id = ?",
          )
          .get(scopeKey, context.request_id) as JobRow | null;
        if (raced && raced.record_sha256 === recordSha) return toJob(raced);
        if (options.ledger && !raced)
          await options.ledger
            .record(context, request.task_id, holdKey, { tokens: 0, usd: 0 })
            .catch((ledgerError: unknown) =>
              reportInternalError("ledger", ledgerError),
            );
        if (error instanceof BrowserError) throw error;
        throw new BrowserError("conflict", "Browser request was not stored");
      }
      schedulePump();
      return toJob(findRow(scopeKey, requestId));
    },

    async inspect(contextInput, requestId) {
      checkOpen();
      const { scopeKey } = parseContext(contextInput);
      if (typeof requestId !== "string")
        throw new BrowserError("invalid_input", "Invalid request id");
      return toJob(findRow(scopeKey, requestId));
    },

    async list(contextInput, filter) {
      checkOpen();
      const { scopeKey } = parseContext(contextInput);
      const taskId = filter?.task_id;
      if (taskId !== undefined && typeof taskId !== "string")
        throw new BrowserError("invalid_input", "Invalid task id");
      const rows = (
        taskId === undefined
          ? db
              .query("SELECT * FROM jobs WHERE scope_key = ? ORDER BY seq")
              .all(scopeKey)
          : db
              .query(
                "SELECT * FROM jobs WHERE scope_key = ? AND task_id = ? ORDER BY seq",
              )
              .all(scopeKey, taskId)
      ) as JobRow[];
      return rows.map(toJob);
    },

    async readResult(contextInput, requestId) {
      checkOpen();
      const { scopeKey } = parseContext(contextInput);
      if (typeof requestId !== "string")
        throw new BrowserError("invalid_input", "Invalid request id");
      const row = findRow(scopeKey, requestId);
      const job = toJob(row);
      const result = db
        .query(
          "SELECT attempt, result_json FROM results WHERE scope_key = ? AND request_id = ?",
        )
        .get(scopeKey, requestId) as {
        attempt: number;
        result_json: string;
      } | null;
      const attempt = result?.attempt ?? row.attempts;
      const steps = (
        db
          .query(
            `SELECT step_json FROM steps WHERE scope_key = ? AND request_id = ?
               AND attempt = ? ORDER BY step_index`,
          )
          .all(scopeKey, requestId, attempt) as Array<{ step_json: string }>
      ).map((step) => {
        const parsed = BrowserStepSchema.safeParse(JSON.parse(step.step_json));
        if (!parsed.success)
          throw new BrowserError("corrupt_record", "Corrupt browser step");
        return parsed.data;
      });
      let parsedResult: BrowserResult | null = null;
      if (result) {
        const parsed = BrowserResultSchema.safeParse(
          JSON.parse(result.result_json),
        );
        if (!parsed.success)
          throw new BrowserError("corrupt_record", "Corrupt browser result");
        parsedResult = parsed.data;
      }
      return { job, steps, result: parsedResult };
    },

    async cancel(contextInput, requestId) {
      checkOpen();
      const { scopeKey } = parseContext(contextInput);
      if (typeof requestId !== "string")
        throw new BrowserError("invalid_input", "Invalid request id");
      findRow(scopeKey, requestId);
      const cancelled = cancelRows(scopeKey, "request_id = ?", requestId);
      await syncHolds(cancelled);
      return toJob(findRow(scopeKey, requestId));
    },

    async markStale(contextInput, taskId, revision) {
      checkOpen();
      const { scopeKey } = parseContext(contextInput);
      if (typeof taskId !== "string" || !Number.isSafeInteger(revision))
        throw new BrowserError("invalid_input", "Invalid stale marker");
      const cancelled = cancelRows(
        scopeKey,
        "task_id = ? AND task_revision < ?",
        taskId,
        String(revision),
      );
      const flagged = immediate(
        () =>
          db
            .query(
              `UPDATE jobs SET stale = 1 WHERE scope_key = ? AND task_id = ?
                 AND task_revision < ? AND stale = 0`,
            )
            .run(scopeKey, taskId, revision).changes,
      );
      await syncHolds(cancelled);
      return flagged;
    },

    async reconcileTask(contextInput, taskId) {
      checkOpen();
      const { context, scopeKey } = parseContext(contextInput);
      const task = await inspectTask(context, taskId);
      if (isTerminalTaskStatus(task.status))
        await syncHolds(cancelRows(scopeKey, "task_id = ?", task.task_id));
    },

    async allowance(contextInput, taskId) {
      checkOpen();
      const { context, scopeKey } = parseContext(contextInput);
      const task = await inspectTask(context, taskId);
      const rows = taskRows(scopeKey, task.task_id);
      let committed = rows.reduce(
        (sum, row) => {
          const next = commitmentOf(row);
          return { tokens: sum.tokens + next.tokens, usd: sum.usd + next.usd };
        },
        { tokens: 0, usd: 0 },
      );
      if (options.ledger) {
        await syncHolds(rows);
        let all: { tokens: number; usd: number };
        try {
          all = await options.ledger.committed(context, task.task_id);
        } catch (error) {
          throw mapTaskError(error);
        }
        committed = {
          tokens: Math.max(all.tokens, committed.tokens),
          usd: Math.max(all.usd, committed.usd),
        };
      }
      return {
        max_tokens: Math.max(0, task.budget.max_tokens - committed.tokens),
        max_usd: remainingUsd(task.budget.max_usd, committed.usd),
      };
    },

    pump: () => (state === "open" ? pump() : Promise.resolve()),
    lastInternalError: () => lastError,

    async close(closeOptions) {
      if (state !== "open") return;
      state = "closing";
      if (poller) clearInterval(poller);
      const runs = [...localRuns.values()];
      for (const entry of runs) entry.controller.abort("closed");
      const drainMs = Math.max(0, closeOptions?.drainMs ?? 5_000);
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(runs.map((entry) => entry.settled)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, drainMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
      // Interrupted runs go back to the queue for the next process.
      immediate(() =>
        db
          .query(
            `UPDATE jobs SET status = 'queued', lease_owner = NULL,
               lease_token = NULL, lease_expires_at = NULL
             WHERE status = 'running' AND lease_owner = ?`,
          )
          .run(instanceId),
      );
      for (const entry of localRuns.values()) {
        clearInterval(entry.heartbeat);
        clearTimeout(entry.deadlineTimer);
      }
      state = "closed";
      store.close();
    },
  };
}
