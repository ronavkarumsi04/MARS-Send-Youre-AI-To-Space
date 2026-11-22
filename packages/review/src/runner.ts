import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  MemoryEntry,
  MemoryOperation,
  MemoryProposalService,
  RequestContext,
  SkillMutationOptions,
  SkillProposalService,
} from "@mars/contracts";
import { MemoryStoreError } from "@mars/memory";
import { SkillError, withDirectoryLock } from "@mars/skills";
import { type ReviewModelGateway, ReviewRateLimit } from "./model";
import {
  InvalidOutput,
  normalizeFact,
  OUTPUT_LIMITS,
  parseOutput,
  type ReviewProposal,
  SYSTEM_PROMPT,
  utf8Bytes,
} from "./output";

/**
 * Single proposal-only background review runner. Ported from
 * mars-platform/services/review (Hermes background-review safety semantics,
 * OpenClaw experience-review scheduling; see NOTICE). It never executes tools,
 * never accepts proposals, never writes authoritative memory or skills, and
 * never schedules itself: only foreground turns are eligible.
 */
export type TurnOrigin =
  | "foreground"
  | "review"
  | "cron"
  | "heartbeat"
  | "subagent";
export interface TranscriptMessage {
  role: "user" | "assistant" | "tool";
  content: string;
}
export interface Turn {
  sessionId: string;
  /** Host task the turn belongs to; memory proposals it yields are linked to it. */
  taskId?: string;
  origin: TurnOrigin;
  iterations: number;
  transcript: readonly TranscriptMessage[];
  success?: boolean;
}
export interface ReviewDependencies {
  /** Exact scope the review proposes into; proposals never widen it. */
  context: RequestContext;
  /**
   * `rejectProposal`/`reject` are optional and used only to withdraw this
   * review's own just-submitted proposals when a later one fails, so the
   * review status and the proposal inbox never disagree.
   */
  memory: Pick<MemoryProposalService, "submitProposal"> &
    Partial<Pick<MemoryProposalService, "rejectProposal">> & {
      snapshot(
        context: RequestContext,
      ): Promise<{ revision: number; entries: MemoryEntry[] }>;
    };
  skills: SkillProposalService & {
    reject?(
      id: string,
      reason: string,
      options?: SkillMutationOptions,
    ): Promise<string>;
  };
  model: ReviewModelGateway;
  logRoot: string;
  idleMs?: number;
  timeoutMs?: number;
  clock?: () => number;
  /** Schedule idle work and return its cancellation function. */
  scheduleIdle?: (callback: () => Promise<void>, delayMs: number) => () => void;
}
export interface ReviewResult {
  reviewId: string;
  status:
    | "completed"
    | "rejected"
    | "cancelled"
    | "rate-limited"
    | "error"
    | "skipped";
  proposals: { store: "memory" | "skills"; id: string }[];
}
export const REVIEW_LIMITS = {
  iterations_threshold: 10,
  pending_sessions: 32,
  counters: 1024,
  context_chars: 64_000,
  memory_entries: 200,
  skills: 64,
  skill_content_chars: 4000,
  max_tokens: 1024,
  backoff_initial_ms: 15 * 60_000,
  backoff_max_ms: 60 * 60_000,
} as const;

const ERROR_MESSAGE_CHARS = 200;
/** Largest delay `setTimeout` honours; longer delays fire immediately. */
const MAX_TIMER_MS = 2_147_483_647;
const ROLES = new Set(["user", "assistant", "tool"]);
const SNAPSHOT_CHANGED = "Snapshot changed";
const UNSUPPORTED = "unsupported";
const SAFE_ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
/**
 * Log-safe cause of a failure. Only messages built from fixed text
 * (`InvalidOutput`, `MemoryStoreError`, the runner's own errors) are kept;
 * provider, skill and I/O messages may quote prompts, replies or paths, so
 * those log just their name and `code`.
 */
const describeError = (error: unknown) => {
  if (!(error instanceof Error)) return { errorName: typeof error };
  const code = (error as { code?: unknown }).code;
  return {
    errorName: error.name,
    ...(typeof code === "string" && SAFE_ERROR_CODE.test(code)
      ? { errorCode: code }
      : {}),
    ...(error instanceof InvalidOutput ||
    error instanceof MemoryStoreError ||
    error.message === SNAPSHOT_CHANGED ||
    error.message === UNSUPPORTED
      ? { errorMessage: error.message.slice(0, ERROR_MESSAGE_CHARS) }
      : {}),
  };
};
/** Matches the memory store's `PROPOSAL_LIMITS.task_id_length`; longer ids submit unlinked. */
const MAX_TASK_LINK_LENGTH = 1024;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const EXCLUDED =
  /(^|:)(review|background_review|cron|heartbeat|hook|subagent|acp|memory|overflow)(:|$)|active-memory|incognito|internal:/i;
/** Recursion guard: only named foreground sessions are ever reviewed. */
export const eligible = (turn: Turn) =>
  Boolean(turn) &&
  typeof turn === "object" &&
  turn.origin === "foreground" &&
  typeof turn.sessionId === "string" &&
  Boolean(turn.sessionId.trim()) &&
  !EXCLUDED.test(turn.sessionId);

/**
 * Detached copy of a host turn holding only the documented fields, so extra
 * keys (on the turn or its messages) never reach the prompt and values that
 * `structuredClone` cannot copy never throw.
 */
function copyTurn(input: Turn): Turn {
  const transcript = Array.isArray(input.transcript)
    ? input.transcript.map((message) =>
        message && typeof message === "object"
          ? { role: message.role, content: message.content }
          : message,
      )
    : input.transcript;
  return {
    sessionId: input.sessionId,
    ...(typeof input.taskId === "string" ? { taskId: input.taskId } : {}),
    origin: input.origin,
    iterations: input.iterations,
    transcript,
    ...(typeof input.success === "boolean" ? { success: input.success } : {}),
  };
}
const validTranscript = (transcript: unknown) =>
  Array.isArray(transcript) &&
  transcript.every(
    (message) =>
      message &&
      typeof message === "object" &&
      ROLES.has(message.role) &&
      typeof message.content === "string",
  );

/**
 * Appends items to the prompt while it stays within the context budget, so a
 * large memory or skill store shrinks the evidence instead of disabling review.
 */
function fit<T>(items: readonly T[], budget: { left: number }): T[] {
  const kept: T[] = [];
  for (const item of items) {
    const cost = JSON.stringify(item).length + (kept.length ? 1 : 0);
    if (cost > budget.left) break;
    budget.left -= cost;
    kept.push(item);
  }
  return kept;
}

/** Rejects with the abort reason as soon as `signal` fires, even if `work` hangs. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Drops memory ops whose fact the store already holds for the same target. */
function withoutKnownFacts(
  proposals: ReviewProposal[],
  entries: readonly MemoryEntry[],
): ReviewProposal[] {
  const known = new Set(
    entries.map((entry) => `${entry.target}\u0000${normalizeFact(entry.fact)}`),
  );
  return proposals.flatMap((proposal): ReviewProposal[] => {
    if (proposal.tool !== "memory.submitProposal") return [proposal];
    const ops = proposal.ops.filter(
      (op) =>
        !known.has(
          `${op.target === "user" ? "profile" : "project"}\u0000${normalizeFact(op.content)}`,
        ),
    );
    return ops.length ? [{ ...proposal, ops }] : [];
  });
}

function memoryEntries(
  context: RequestContext,
  reviewId: string,
  proposalIndex: number,
  ops: { target: "memory" | "user"; content: string }[],
  now: string,
): MemoryOperation[] {
  return ops.map((op, index) => {
    const target = op.target === "user" ? "profile" : "project";
    const scope =
      target === "profile"
        ? {
            owner_id: context.scope.owner_id,
            project_id: context.scope.project_id,
          }
        : context.scope;
    const entry: MemoryEntry = {
      entry_id: `review:${reviewId}:${proposalIndex}:${index}`,
      scope,
      target,
      fact: op.content,
      revision: 0,
      source_event_ids: [`review:${reviewId}`],
      observed_at: now,
      verified_at: null,
      supersedes: null,
      deleted: false,
    };
    return { operation: "add", entry };
  });
}

export class ReviewRunner {
  private readonly deps: ReviewDependencies;
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly timeoutMs: number;
  private readonly logRoot: string;
  private counters = new Map<string, number>();
  private pending = new Map<string, Turn>();
  private live = new Set<string>();
  private cancelTimer: (() => void) | undefined;
  private running: Promise<ReviewResult> | undefined;
  private abort: AbortController | undefined;
  private stopped = false;
  private cooldown = 0;
  private backoff = 0;
  private quietUntil = 0;
  private requests = 0;

  constructor(deps: ReviewDependencies) {
    this.deps = {
      ...deps,
      context: structuredClone(deps.context),
      memory: {
        snapshot: deps.memory.snapshot.bind(deps.memory),
        submitProposal: deps.memory.submitProposal.bind(deps.memory),
        ...(deps.memory.rejectProposal
          ? { rejectProposal: deps.memory.rejectProposal.bind(deps.memory) }
          : {}),
      },
      skills: {
        list: deps.skills.list.bind(deps.skills),
        getRevision: deps.skills.getRevision.bind(deps.skills),
        submitProposal: deps.skills.submitProposal.bind(deps.skills),
        ...(deps.skills.reject
          ? { reject: deps.skills.reject.bind(deps.skills) }
          : {}),
      },
    };
    this.now = deps.clock ?? Date.now;
    this.idleMs = deps.idleMs ?? 30_000;
    this.timeoutMs = deps.timeoutMs ?? 60_000;
    if (
      !Number.isFinite(this.idleMs) ||
      this.idleMs < 0 ||
      this.idleMs > MAX_TIMER_MS ||
      !Number.isFinite(this.timeoutMs) ||
      this.timeoutMs <= 0 ||
      this.timeoutMs > MAX_TIMER_MS
    )
      throw new Error("Invalid review timing");
    this.logRoot = resolve(deps.logRoot);
  }

  /** Number of model calls made so far (offline tests assert 0 without a fake). */
  get modelRequests() {
    return this.requests;
  }
  get pendingSessions() {
    return [...this.pending.keys()];
  }

  private async log(
    turn: Turn,
    result: ReviewResult,
    event: string,
    extra: Record<string, unknown> = {},
  ) {
    const record = {
      ts: new Date(this.now()).toISOString(),
      actor: "@mars/review",
      source: "background_review",
      sessionId: turn.sessionId,
      reviewId: result.reviewId,
      model: this.deps.model.id,
      event,
      ...extra,
    };
    await mkdir(this.logRoot, { recursive: true, mode: 0o700 });
    await withDirectoryLock(this.logRoot, () =>
      appendFile(
        join(this.logRoot, "review.jsonl"),
        `${JSON.stringify(record)}\n`,
        { mode: 0o600 },
      ),
    );
  }
  private arm() {
    this.cancelTimer?.();
    if (this.stopped || this.running || this.live.size || !this.pending.size)
      return;
    const schedule =
      this.deps.scheduleIdle ??
      ((callback, delayMs) => {
        const timer = setTimeout(() => void callback(), delayMs);
        timer.unref();
        return () => clearTimeout(timer);
      });
    this.cancelTimer = schedule(
      async () => {
        this.cancelTimer = undefined;
        const next = this.pending.entries().next();
        if (next.done) return;
        // reviewNow removes the session only once it actually starts, so a
        // timer that fires early (cooldown not over yet) keeps it queued.
        const result = await this.reviewNow(next.value[1]).catch(
          () => undefined,
        );
        if (result?.status === "skipped") this.arm();
      },
      Math.min(
        MAX_TIMER_MS,
        Math.max(0, this.quietUntil - this.now(), this.cooldown - this.now()),
      ),
    );
  }
  /** Foreground work is starting: defer scheduling and cancel in-flight review. */
  beginLiveTurn(sessionId: string) {
    this.live.add(sessionId);
    this.cancelTimer?.();
    this.abort?.abort();
  }
  endLiveTurn(sessionId: string) {
    this.live.delete(sessionId);
    this.quietUntil = this.now() + this.idleMs;
    this.arm();
  }
  /** Queue a turn, keeping a newer queued turn unless `replace`, and evicting the oldest past the cap. */
  private enqueue(turn: Turn, replace: boolean) {
    if (this.pending.has(turn.sessionId)) {
      if (replace) this.pending.set(turn.sessionId, turn);
      return;
    }
    if (this.pending.size >= REVIEW_LIMITS.pending_sessions) {
      const oldest = this.pending.keys().next();
      if (!oldest.done) this.pending.delete(oldest.value);
    }
    this.pending.set(turn.sessionId, turn);
  }
  /** Record a completed foreground turn; review runs once 10 iterations accumulate. */
  recordTurn(input: Turn) {
    if (this.stopped || !eligible(input)) return;
    const turn = copyTurn(input);
    this.quietUntil = this.now() + this.idleMs;
    if (turn.success === false) {
      this.arm();
      return;
    }
    if (!Number.isSafeInteger(turn.iterations) || turn.iterations <= 0) return;
    const count = (this.counters.get(turn.sessionId) ?? 0) + turn.iterations;
    if (
      this.pending.has(turn.sessionId) ||
      count >= REVIEW_LIMITS.iterations_threshold
    ) {
      this.counters.delete(turn.sessionId);
      this.enqueue(turn, true);
    } else {
      this.counters.delete(turn.sessionId);
      this.counters.set(turn.sessionId, count);
      if (this.counters.size > REVIEW_LIMITS.counters) {
        const oldest = this.counters.keys().next();
        if (!oldest.done) this.counters.delete(oldest.value);
      }
    }
    this.arm();
  }
  async reviewNow(input: Turn): Promise<ReviewResult> {
    const result: ReviewResult = {
      reviewId: randomUUID(),
      status: "skipped",
      proposals: [],
    };
    if (!eligible(input)) return result;
    const turn = copyTurn(input);
    if (
      this.stopped ||
      this.live.size ||
      this.running ||
      this.now() < this.cooldown
    )
      return result;
    this.cancelTimer?.();
    this.pending.delete(turn.sessionId);
    const abort = new AbortController();
    this.abort = abort;
    const deadline = Date.now() + this.timeoutMs;
    const timeout = setTimeout(() => abort.abort(), this.timeoutMs);
    const action = this.execute(turn, result, abort.signal, deadline);
    this.running = action;
    try {
      return await action;
    } finally {
      clearTimeout(timeout);
      this.running = undefined;
      this.abort = undefined;
      this.arm();
    }
  }
  private async execute(
    turn: Turn,
    result: ReviewResult,
    signal: AbortSignal,
    deadline: number,
  ): Promise<ReviewResult> {
    let outputHash: string | undefined;
    let failure: ReturnType<typeof describeError> | undefined;
    const context = this.deps.context;
    try {
      await this.log(turn, result, "started", {
        transcriptHash: hash(JSON.stringify(turn.transcript) ?? ""),
      });
      signal.throwIfAborted();
      if (!validTranscript(turn.transcript))
        throw new InvalidOutput("transcript");
      const [memory, skillsRevision] = await abortable(
        Promise.all([
          this.deps.memory.snapshot(context),
          this.deps.skills.getRevision(),
        ]),
        signal,
      );
      const skills = await abortable(this.deps.skills.list(), signal);
      if (
        (await abortable(this.deps.skills.getRevision(), signal)) !==
        skillsRevision
      )
        throw new Error(SNAPSHOT_CHANGED);
      const evidence = {
        untrusted_evidence: true,
        transcript: turn.transcript,
        memory: [] as { target: string; fact: string }[],
        skills: [] as { name: string; status: string; content: string }[],
        memoryRevision: memory.revision,
        skillsRevision,
      };
      const budget = {
        left: REVIEW_LIMITS.context_chars - JSON.stringify(evidence).length,
      };
      if (budget.left < 0) throw new InvalidOutput("context size");
      evidence.memory = fit(
        memory.entries
          .slice(0, REVIEW_LIMITS.memory_entries)
          .map((entry) => ({ target: entry.target, fact: entry.fact })),
        budget,
      );
      evidence.skills = fit(
        skills
          .filter((skill) => skill.status !== "archived")
          .slice(0, REVIEW_LIMITS.skills)
          .map((skill) => ({
            name: skill.name,
            status: skill.status,
            content: skill.content.slice(0, REVIEW_LIMITS.skill_content_chars),
          })),
        budget,
      );
      const prompt = JSON.stringify(evidence);
      if (prompt.length > REVIEW_LIMITS.context_chars)
        throw new InvalidOutput("context size");
      signal.throwIfAborted();
      this.requests++;
      const reply = await abortable(
        this.deps.model.complete({
          system: SYSTEM_PROMPT,
          user: prompt,
          maxTokens: REVIEW_LIMITS.max_tokens,
          timeoutMs: Math.max(1, deadline - Date.now()),
          signal,
        }),
        signal,
      );
      if (
        !reply ||
        typeof reply !== "object" ||
        reply.toolCalls ||
        (reply.finishReason !== null && reply.finishReason !== "stop") ||
        typeof reply.text !== "string" ||
        utf8Bytes(reply.text) > OUTPUT_LIMITS.output_bytes
      )
        throw new InvalidOutput("reply");
      outputHash = hash(reply.text);
      const proposals = withoutKnownFacts(
        parseOutput(reply.text),
        memory.entries,
      );
      signal.throwIfAborted();
      const source = `background_review:${turn.sessionId}:${result.reviewId}`;
      const now = new Date(this.now()).toISOString();
      for (const [proposalIndex, proposal] of proposals.entries()) {
        signal.throwIfAborted();
        if (
          (await abortable(this.deps.memory.snapshot(context), signal))
            .revision !== memory.revision ||
          (await abortable(this.deps.skills.getRevision(), signal)) !==
            skillsRevision
        )
          throw new Error(SNAPSHOT_CHANGED);
        signal.throwIfAborted();
        if (proposal.tool === "memory.submitProposal") {
          const submitted = await this.deps.memory.submitProposal(
            {
              ...context,
              request_id: `${context.request_id}:${result.reviewId}`,
            },
            {
              source,
              rationale: proposal.rationale,
              expected_revision: memory.revision,
              ...(turn.taskId && turn.taskId.length <= MAX_TASK_LINK_LENGTH
                ? { task_id: turn.taskId }
                : {}),
              operations: memoryEntries(
                context,
                result.reviewId,
                proposalIndex,
                proposal.ops,
                now,
              ),
            },
          );
          result.proposals.push({ store: "memory", id: submitted.proposal_id });
          await this.log(turn, result, "proposal", {
            store: "memory",
            proposalId: submitted.proposal_id,
            memoryRevision: memory.revision,
            skillsRevision,
          });
        } else {
          const submitted = await this.deps.skills.submitProposal(
            { source, rationale: proposal.rationale, ops: proposal.ops },
            {
              actor: "@mars/review",
              source,
              reviewId: result.reviewId,
              expectedRevision: skillsRevision,
            },
          );
          result.proposals.push({ store: "skills", id: submitted.id });
          await this.log(turn, result, "proposal", {
            store: "skills",
            proposalId: submitted.id,
            expectedRevision: submitted.expectedRevision,
            memoryRevision: memory.revision,
            skillsRevision,
          });
        }
      }
      signal.throwIfAborted();
      this.backoff = 0;
      result.status = "completed";
    } catch (error) {
      failure = describeError(error);
      if (result.proposals.length) await this.withdraw(turn, result, error);
      if (signal.aborted) result.status = "cancelled";
      else if (error instanceof ReviewRateLimit) {
        result.status = "rate-limited";
        this.backoff = Math.min(
          REVIEW_LIMITS.backoff_max_ms,
          this.backoff * 2 || REVIEW_LIMITS.backoff_initial_ms,
        );
        this.cooldown = this.now() + this.backoff;
        if (!this.stopped) this.enqueue(turn, false);
      } else
        result.status =
          error instanceof InvalidOutput ||
          error instanceof SyntaxError ||
          error instanceof MemoryStoreError ||
          error instanceof SkillError
            ? "rejected"
            : "error";
    }
    // The returned result is authoritative; a failing audit write must not
    // turn a finished review (whose proposals are in the inbox) into a throw.
    await this.log(turn, result, result.status, {
      proposals: result.proposals,
      outputHash,
      cooldownUntil: this.cooldown || undefined,
      ...failure,
    }).catch(() => undefined);
    return result;
  }
  /**
   * A review is all-or-nothing: if any submission fails after earlier ones
   * succeeded, withdraw (reject) this review's own proposals so the inbox
   * matches the reported status. Withdrawal failures are logged, never thrown.
   */
  private async withdraw(
    turn: Turn,
    result: ReviewResult,
    cause: unknown,
  ): Promise<void> {
    const reason = `Withdrawn: review ${result.reviewId} ${
      cause instanceof Error ? cause.name : "failed"
    }`;
    const withdrawn: ReviewResult["proposals"] = [];
    const failed: ({
      proposal: ReviewResult["proposals"][number];
    } & ReturnType<typeof describeError>)[] = [];
    for (const proposal of result.proposals.splice(0)) {
      try {
        if (proposal.store === "memory") {
          if (!this.deps.memory.rejectProposal) throw new Error(UNSUPPORTED);
          await this.deps.memory.rejectProposal(
            this.deps.context,
            proposal.id,
            reason,
          );
        } else {
          if (!this.deps.skills.reject) throw new Error(UNSUPPORTED);
          await this.deps.skills.reject(proposal.id, reason, {
            actor: "@mars/review",
            source: "background_review",
            reviewId: result.reviewId,
          });
        }
        withdrawn.push(proposal);
      } catch (error) {
        result.proposals.push(proposal);
        failed.push({ proposal, ...describeError(error) });
      }
    }
    await this.log(turn, result, "withdrawn", {
      withdrawn,
      remaining: failed,
    }).catch(() => undefined);
  }
  /** Clears pending work, aborts in-flight review and drains it. */
  async stop() {
    this.stopped = true;
    this.cancelTimer?.();
    this.pending.clear();
    this.counters.clear();
    this.abort?.abort();
    await this.running?.catch(() => undefined);
  }
}
