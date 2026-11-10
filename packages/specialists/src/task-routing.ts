import { exceedsUsd, type RequestContext, remainingUsd } from "@mars/contracts";
import { SpecialistRegistryError } from "./errors";
import { parseRef, type SpecialistRegistry } from "./registry";
import {
  type ReasonCode,
  type RoutingDecision,
  type RoutingRequest,
  RoutingRequestSchema,
  type SelectedTarget,
  type TaskRoutingState,
} from "./schemas";

export const TASK_ROUTING_STEP_SCHEMA = "mars.specialist-routing-step/v1";

export const STEP_REASON_CODES = [
  "pinned_rolled_back",
  "pinned_superseded",
  "pinned_retired",
  "pinned_ineligible",
  "unattested_adapter_refused",
  "budget_tokens_exhausted",
  "budget_usd_exhausted",
  "deadline_exhausted",
] as const;
export type StepReasonCode = (typeof STEP_REASON_CODES)[number];

export type TaskRoutingMode =
  | "routed"
  | "pinned"
  | "fallback"
  | "unavailable"
  | "budget_exhausted";

/** Durable usage already charged to the task, from the host's budget ledger. */
export interface TaskRoutingUsage {
  tokens: number;
  usd: number;
}

export interface TaskRoutingInput {
  /** Whole-task request; `budget` is the task's total budget. */
  request: RoutingRequest;
  usage?: TaskRoutingUsage;
  /** Absolute task deadline in epoch milliseconds. */
  deadline_at?: number;
}

/** Task evidence for one routing step. Contains refs and codes, never paths. */
export interface TaskRoutingStep {
  schema: typeof TASK_ROUTING_STEP_SCHEMA;
  task_id: string;
  role: RoutingRequest["role"];
  step: number;
  mode: TaskRoutingMode;
  decision_id: string | null;
  decision_ids: string[];
  selected: SelectedTarget | null;
  fallback_from: string | null;
  rejected: Array<{ ref: string; reasons: string[] }>;
  step_reasons: StepReasonCode[];
  lost_refs: string[];
  remaining: { tokens: number; usd: number; duration_ms: number };
}

export interface TaskRoutingResult {
  step: TaskRoutingStep;
  state: TaskRoutingState;
}

export interface SpecialistTaskRouterOptions {
  /** Persists each committed step as task evidence. Errors propagate. */
  record?: (context: RequestContext, step: TaskRoutingStep) => Promise<void>;
  now?: () => number;
}

type Registry = Pick<
  SpecialistRegistry,
  | "route"
  | "inspect"
  | "fallbackChain"
  | "taskRoutingState"
  | "commitTaskRoutingState"
>;

interface Pick_ {
  decision: RoutingDecision;
  target: SelectedTarget;
}

/**
 * Routes every step of a task through `SpecialistRegistry.route`. The first
 * step routes normally; later steps keep the pinned target only while it is
 * still the production revision and still passes every registry gate
 * (evidence, serving attestation, budget). A target that loses eligibility is
 * recorded in `lost_refs`, and the step falls back along
 * `fallback_specialist_revision` and then to the explicit baselines. An
 * adapter target is never returned without verified serving attestation.
 */
export class SpecialistTaskRouter {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly registry: Registry,
    private readonly options: SpecialistTaskRouterOptions = {},
  ) {}

  async routeStep(
    context: RequestContext,
    input: TaskRoutingInput,
  ): Promise<TaskRoutingResult> {
    const parsed = RoutingRequestSchema.safeParse(input.request);
    if (!parsed.success) {
      throw new SpecialistRegistryError("invalid_input", "routing_request");
    }
    const request = parsed.data;
    if (request.override) {
      throw new SpecialistRegistryError("invalid_input", "step_override");
    }
    const usage = input.usage ?? { tokens: 0, usd: 0 };
    if (
      !Number.isFinite(usage.tokens) ||
      usage.tokens < 0 ||
      !Number.isFinite(usage.usd) ||
      usage.usd < 0 ||
      (input.deadline_at !== undefined && !Number.isFinite(input.deadline_at))
    ) {
      throw new SpecialistRegistryError("invalid_input", "task_usage");
    }
    const key = JSON.stringify([
      context.scope.owner_id,
      context.scope.project_id,
      context.scope.workspace_id ?? null,
      request.task_id,
      request.role,
    ]);
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(() => this.step(context, request, usage, input.deadline_at));
    this.locks.set(key, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === run) this.locks.delete(key);
    }
  }

  private async step(
    context: RequestContext,
    request: RoutingRequest,
    usage: TaskRoutingUsage,
    deadlineAt: number | undefined,
  ): Promise<TaskRoutingResult> {
    const prior =
      (await this.registry.taskRoutingState(
        context,
        request.task_id,
        request.role,
      )) ?? null;
    const lost = new Set(prior?.lost_refs ?? []);
    const stepReasons = new Set<StepReasonCode>();
    const rejected = new Map<string, Set<string>>();
    const decisionIds: string[] = [];
    const reject = (ref: string, reasons: readonly string[]) => {
      const set = rejected.get(ref) ?? new Set<string>();
      for (const reason of reasons) set.add(reason);
      rejected.set(ref, set);
    };
    const now = this.options.now?.() ?? Date.now();
    const tokens = request.budget.max_tokens - usage.tokens;
    const usd = remainingUsd(request.budget.max_usd, usage.usd);
    const duration =
      deadlineAt === undefined
        ? request.budget.max_duration_ms
        : Math.min(request.budget.max_duration_ms, Math.ceil(deadlineAt - now));
    if (tokens <= 0) stepReasons.add("budget_tokens_exhausted");
    if (exceedsUsd(usage.usd, request.budget.max_usd)) {
      stepReasons.add("budget_usd_exhausted");
    }
    if (duration <= 0) stepReasons.add("deadline_exhausted");

    let mode: TaskRoutingMode = "unavailable";
    let chosen: Pick_ | null = null;
    let fallbackFrom: string | null = null;
    let pinned = prior?.pinned ?? null;
    let lastDecision: RoutingDecision | null = null;
    if (stepReasons.size > 0) {
      mode = "budget_exhausted";
    } else {
      const budgeted: RoutingRequest = {
        ...request,
        budget: {
          ...request.budget,
          max_tokens: tokens,
          max_usd: usd,
          max_duration_ms: duration,
        },
      };
      const route = async (
        extra: Partial<RoutingRequest>,
      ): Promise<RoutingDecision> => {
        const exclude = [
          ...new Set([...(request.exclude_refs ?? []), ...lost]),
        ];
        const decision = await this.registry.route(context, {
          ...budgeted,
          ...(exclude.length > 0 ? { exclude_refs: exclude } : {}),
          ...extra,
        });
        decisionIds.push(decision.decision_id);
        lastDecision = decision;
        for (const item of decision.rejected) reject(item.ref, item.reasons);
        return decision;
      };
      const guarded = (decision: RoutingDecision): Pick_ | null => {
        if (
          decision.outcome !== "specialist" &&
          decision.outcome !== "baseline"
        ) {
          return null;
        }
        const target = decision.selected;
        if (!target) return null;
        if (
          target.adapter_sha256 !== null &&
          target.serving_attestation !== "verified"
        ) {
          stepReasons.add("unattested_adapter_refused");
          reject(target.ref, ["serving_unattested"]);
          lost.add(target.ref);
          return null;
        }
        return { decision, target };
      };
      const tryRef = async (ref: string): Promise<Pick_ | null> => {
        const decision = await route({ override: { ref } });
        const pick = guarded(decision);
        return pick && pick.target.ref === ref ? pick : null;
      };

      if (pinned) {
        const lossReason = await this.pinLoss(context, pinned);
        const pick = lossReason ? null : await tryRef(pinned.ref);
        if (pick) {
          chosen = pick;
          mode = "pinned";
        } else {
          stepReasons.add(lossReason ?? "pinned_ineligible");
          if (lossReason) reject(pinned.ref, [lossReason]);
          lost.add(pinned.ref);
          fallbackFrom = pinned.ref;
          for (const ref of await this.configuredChain(
            context,
            pinned.ref,
            reject,
          )) {
            if (lost.has(ref) || (request.exclude_refs ?? []).includes(ref)) {
              continue;
            }
            chosen = await tryRef(ref);
            if (chosen) break;
          }
          if (!chosen) chosen = guarded(await route({}));
          if (chosen) mode = "fallback";
        }
      } else {
        chosen = guarded(await route({}));
        if (chosen) mode = chosen.decision.fallback ? "fallback" : "routed";
        if (chosen?.decision.fallback) {
          fallbackFrom = chosen.decision.fallback.from;
        }
      }
      if (chosen && mode !== "pinned") {
        pinned = {
          ref: chosen.target.ref,
          via: mode === "fallback" ? "fallback" : "route",
          decision_id: chosen.decision.decision_id,
        };
      } else if (!chosen) {
        pinned = null;
      }
    }
    if (mode === "budget_exhausted") pinned = prior?.pinned ?? null;

    const expectedStep = prior?.step ?? 0;
    const state: TaskRoutingState = {
      schema_version: 1,
      task_id: request.task_id,
      role: request.role,
      step: expectedStep + 1,
      pinned,
      lost_refs: [...lost],
      last_decision_id:
        (lastDecision as RoutingDecision | null)?.decision_id ??
        prior?.last_decision_id ??
        null,
    };
    await this.registry.commitTaskRoutingState(context, state, expectedStep);
    const step: TaskRoutingStep = {
      schema: TASK_ROUTING_STEP_SCHEMA,
      task_id: request.task_id,
      role: request.role,
      step: state.step,
      mode,
      decision_id: chosen?.decision.decision_id ?? state.last_decision_id,
      decision_ids: decisionIds,
      selected: chosen?.target ?? null,
      fallback_from: fallbackFrom,
      rejected: [...rejected].map(([ref, reasons]) => ({
        ref,
        reasons: [...reasons].sort(),
      })),
      step_reasons: [...stepReasons].sort(),
      lost_refs: state.lost_refs,
      remaining: {
        tokens: Math.max(0, tokens),
        usd,
        duration_ms: Math.max(0, duration),
      },
    };
    await this.options.record?.(context, step);
    return { step, state };
  }

  /** Lifecycle loss of a production-routed specialist pin, if any. */
  private async pinLoss(
    context: RequestContext,
    pinned: NonNullable<TaskRoutingState["pinned"]>,
  ): Promise<StepReasonCode | null> {
    const ref = parseRef(pinned.ref);
    if (!ref || ref.kind !== "specialist" || pinned.via !== "route") {
      return null;
    }
    let inspection: Awaited<ReturnType<Registry["inspect"]>>;
    try {
      inspection = await this.registry.inspect(context, ref.id);
    } catch (error) {
      if (
        error instanceof SpecialistRegistryError &&
        error.code === "not_found"
      ) {
        return "pinned_ineligible";
      }
      throw error;
    }
    if (inspection.pointer.retired) return "pinned_retired";
    if (inspection.pointer.production_revision === ref.revision) return null;
    const revision = inspection.revisions.find(
      (item) => item.registration.revision === ref.revision,
    );
    return revision?.rolled_back ? "pinned_rolled_back" : "pinned_superseded";
  }

  /** The pinned specialist's `fallback_specialist_revision` chain. */
  private async configuredChain(
    context: RequestContext,
    fromRef: string,
    reject: (ref: string, reasons: readonly string[]) => void,
  ): Promise<string[]> {
    const ref = parseRef(fromRef);
    if (!ref || ref.kind !== "specialist") return [];
    let inspection: Awaited<ReturnType<Registry["inspect"]>>;
    try {
      inspection = await this.registry.inspect(context, ref.id);
    } catch (error) {
      if (
        error instanceof SpecialistRegistryError &&
        error.code === "not_found"
      ) {
        return [];
      }
      throw error;
    }
    const registration = inspection.revisions.find(
      (item) => item.registration.revision === ref.revision,
    )?.registration;
    if (!registration) return [];
    const start = registration.fallback_specialist_revision;
    const resolved = await this.registry.fallbackChain(
      context,
      start,
      registration.scope,
    );
    if (resolved.error) {
      reject(start, [resolved.error satisfies ReasonCode]);
      return [];
    }
    return resolved.chain;
  }
}
