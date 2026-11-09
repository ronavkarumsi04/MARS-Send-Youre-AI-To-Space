import { createHash } from "node:crypto";
import {
  REQUIRED_CHECK_DEFAULT_TIMEOUT_MS,
  type RequestContext,
  type RequiredCheck,
  RequiredCheckSchema,
  type Scope,
  type Task,
  VERIFICATION_EVIDENCE_OPERATION,
  type VerificationCheckResult,
  type VerificationEvidenceRecord,
  VerificationEvidenceRecordSchema,
  type WorkspaceRef,
} from "@mars/contracts";
import type { RuntimeSession } from "@mars/execution";
import type { DurableTaskStore } from "@mars/tasks";
import type { WorkspaceHost } from "./host";
import {
  errorCodeOf,
  internalContext,
  WORKBENCH_PRODUCER,
  workbenchEvent,
} from "./host-shared";
import { WorkspaceRefSchema } from "./protocol";

const MAX_VERIFICATION_RECORDS = 50;
/** Fragments of the text-form tool-call syntax some models emit instead of a structured call. */
const TEXTUAL_TOOL_CALL = /<function=[A-Za-z0-9_]+>|<\/?tool_call>/;

function textualToolCallDiagnostic(content: string): string | null {
  const match = TEXTUAL_TOOL_CALL.exec(content);
  if (!match) return null;
  return `Assistant text contains a tool call written as text (${match[0]}); it was never executed. Tools run only through validated structured calls.`;
}

function expectedDigest(check: RequiredCheck): string {
  return (
    check.sha256 ??
    createHash("sha256")
      .update(check.content ?? "", "utf8")
      .digest("hex")
  );
}

/**
 * Launch metadata keeps only the digest form of each required check, so a
 * start that was accepted can never write a launch the host refuses to read
 * (expected bytes travel in the request, not in `launch.json`).
 */
export function freezeRequiredChecks(
  checks: readonly RequiredCheck[],
): RequiredCheck[] {
  return checks.map((check) =>
    RequiredCheckSchema.parse({
      kind: check.kind,
      path: check.path,
      sha256: expectedDigest(check),
      ...(check.timeout_ms !== undefined
        ? { timeout_ms: check.timeout_ms }
        : {}),
    }),
  );
}

class CheckTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Required check timed out after ${timeoutMs} ms`);
    this.name = "CheckTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new CheckTimeoutError(timeoutMs)),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/** What host-run required-check verification reads and writes. */
export interface VerificationHost {
  scope: Scope;
  store: DurableTaskStore;
  workspace: Pick<WorkspaceHost, "reopen" | "read">;
}

/**
 * The host-owned verdict: re-reads the candidate (the workspace revision
 * after the agent stopped), runs every required check against it with a
 * bounded timeout, confirms the revision did not move meanwhile, and
 * persists the result as task evidence. Never throws; an unavailable
 * verifier is `inconclusive`, never `passed`.
 */
export async function verifyCandidate(
  host: VerificationHost,
  task: Task,
  runtime: Pick<RuntimeSession, "sessionId">,
  requiredChecks: readonly RequiredCheck[],
  content: string,
): Promise<VerificationEvidenceRecord | null> {
  if (requiredChecks.length === 0) return null;
  const context = internalContext(host.scope);
  const startedAt = Date.now();
  const diagnostics: string[] = [];
  const textual = textualToolCallDiagnostic(content);
  if (textual) diagnostics.push(textual);
  const persist = async (record: VerificationEvidenceRecord) => {
    await host.store
      .appendEvent(
        context,
        task.task_id,
        workbenchEvent(record, runtime.sessionId),
      )
      .catch(() => undefined);
    return record;
  };
  let candidate: WorkspaceRef;
  try {
    candidate = WorkspaceRefSchema.parse(
      await withTimeout(
        host.workspace.reopen(context, task.task_id),
        REQUIRED_CHECK_DEFAULT_TIMEOUT_MS,
      ),
    );
  } catch {
    // No candidate can be named, so no check can run; the failure is still
    // evidence (inconclusive), never silence that reads as "unverified".
    return persist(
      VerificationEvidenceRecordSchema.parse({
        schema_version: 1,
        operation: VERIFICATION_EVIDENCE_OPERATION,
        run_id: runtime.sessionId,
        task_id: task.task_id,
        task_revision: task.revision,
        candidate: null,
        verdict: "inconclusive",
        verified: false,
        checks: [],
        reasons: [
          "Candidate revision could not be acquired; required checks did not run",
        ],
        diagnostics,
        duration_ms: Math.max(0, Date.now() - startedAt),
        recorded_at: new Date().toISOString(),
      } satisfies VerificationEvidenceRecord),
    );
  }
  const checks: VerificationCheckResult[] = [];
  const reasons: string[] = [];
  for (const check of requiredChecks) {
    const expected = expectedDigest(check);
    const timeoutMs = check.timeout_ms ?? REQUIRED_CHECK_DEFAULT_TIMEOUT_MS;
    const began = Date.now();
    let status: VerificationCheckResult["status"];
    let reason: string | null = null;
    let observed: string | null = null;
    try {
      const artifact = await withTimeout(
        host.workspace.read(context, candidate, check.path),
        timeoutMs,
      );
      observed = artifact.sha256;
      if (artifact.sha256 === expected) status = "passed";
      else {
        status = "failed";
        reason = `Required file content mismatch: ${check.path}`;
      }
    } catch (error) {
      if (error instanceof CheckTimeoutError) {
        status = "inconclusive";
        reason = `${error.message}: ${check.path}`;
      } else if (error instanceof Error && errorCodeOf(error) === "not_found") {
        status = "failed";
        reason = `Required file missing: ${check.path}`;
      } else {
        status = "inconclusive";
        reason = `Verifier unavailable for ${check.path}`;
      }
    }
    if (reason) reasons.push(reason);
    checks.push({
      kind: check.kind,
      path: check.path,
      expected_sha256: expected,
      observed_sha256: observed,
      status,
      reason,
      duration_ms: Math.max(0, Date.now() - began),
    });
  }
  let verdict: VerificationEvidenceRecord["verdict"] = checks.some(
    (check) => check.status === "failed",
  )
    ? "failed"
    : checks.some((check) => check.status === "inconclusive")
      ? "inconclusive"
      : "passed";
  try {
    const after = await withTimeout(
      host.workspace.reopen(context, task.task_id),
      REQUIRED_CHECK_DEFAULT_TIMEOUT_MS,
    );
    if (after.revision !== candidate.revision) {
      verdict = "inconclusive";
      reasons.push("Workspace revision changed while checks were running");
    }
  } catch {
    verdict = "inconclusive";
    reasons.push("Candidate revision could not be confirmed after checks");
  }
  return persist(
    VerificationEvidenceRecordSchema.parse({
      schema_version: 1,
      operation: VERIFICATION_EVIDENCE_OPERATION,
      run_id: runtime.sessionId,
      task_id: task.task_id,
      task_revision: task.revision,
      candidate,
      verdict,
      verified:
        verdict === "passed" &&
        checks.every((check) => check.status === "passed"),
      checks,
      reasons,
      diagnostics,
      duration_ms: Math.max(0, Date.now() - startedAt),
      recorded_at: new Date().toISOString(),
    } satisfies VerificationEvidenceRecord),
  );
}

export async function verificationRecords(
  host: VerificationHost,
  context: RequestContext,
  taskId: string,
): Promise<VerificationEvidenceRecord[]> {
  const records: VerificationEvidenceRecord[] = [];
  for await (const event of host.store.events(context, taskId)) {
    if (
      event.event_type !== "tool.completed" ||
      event.producer !== WORKBENCH_PRODUCER
    )
      continue;
    const bytes = await host.store.artifacts.get(context, event.payload);
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      continue;
    }
    if (
      !payload ||
      typeof payload !== "object" ||
      (payload as { operation?: unknown }).operation !==
        VERIFICATION_EVIDENCE_OPERATION
    )
      continue;
    const parsed = VerificationEvidenceRecordSchema.safeParse(payload);
    if (parsed.success && parsed.data.task_id === taskId)
      records.push(parsed.data);
  }
  return records.slice(-MAX_VERIFICATION_RECORDS);
}
