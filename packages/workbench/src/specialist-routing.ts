import { createHash } from "node:crypto";
import type { RequestContext, Task } from "@mars/contracts";
import {
  ID_PATTERN,
  type RoutingDecision,
  type RoutingRequest,
  type TaskRoutingInput,
  type TaskRoutingStep,
} from "@mars/specialists";
import { z } from "zod";

/** The only registry capability the workbench needs: evidence-gated routing. */
export interface SpecialistRouter {
  route(
    context: RequestContext,
    request: RoutingRequest,
  ): Promise<RoutingDecision>;
}

/**
 * Optional per-step routing (`SpecialistTaskRouter`). When present, launches,
 * children and resumes route through it so a specialist that is rolled back
 * or loses serving attestation mid-task is replaced by its fallback.
 */
export interface SpecialistStepRouter {
  routeStep(
    context: RequestContext,
    input: TaskRoutingInput,
  ): Promise<{ step: TaskRoutingStep }>;
}

export interface WorkbenchSpecialists {
  router: SpecialistRouter;
  steps?: SpecialistStepRouter;
  /** Task coverage key (\`area/kind\`) this workbench's tasks are evaluated under. */
  domain: string;
  complexity?: "light" | "medium" | "heavy";
  /** Paid specialists also require the model registry policy to allow paid routing. */
  paid_consent?: boolean;
}

export const FrozenRoutingSchema = z
  .object({
    decision_id: z.string().uuid(),
    routing_task_id: z.string().min(1),
    outcome: z.enum([
      "specialist",
      "baseline",
      "unavailable",
      "override_rejected",
    ]),
    ref: z.string().min(1).nullable(),
    specialist_revision: z.string().min(1).nullable(),
    model_id: z.string().min(1).nullable(),
  })
  .strict();
export type FrozenRouting = z.infer<typeof FrozenRoutingSchema>;

/**
 * Workbench task ids are free-form; the registry only accepts its own id
 * pattern. Ids that already match are used as-is, others get a stable alias
 * so the persisted decision can still be traced back to the task.
 */
export function routingTaskId(taskId: string): string {
  if (ID_PATTERN.test(taskId)) return taskId;
  return `task.${createHash("sha256").update(taskId, "utf8").digest("hex")}`;
}

export function routingRequest(
  task: Pick<Task, "task_id" | "budget">,
  toolsRequired: boolean,
  specialists: Pick<
    WorkbenchSpecialists,
    "domain" | "complexity" | "paid_consent"
  >,
  minContextTokens: number,
  role: RoutingRequest["role"] = "worker",
): RoutingRequest {
  return {
    schema_version: 1,
    task_id: routingTaskId(task.task_id),
    role,
    domain: specialists.domain,
    complexity: specialists.complexity ?? "medium",
    requires: {
      tools: toolsRequired,
      vision: false,
      reasoning: false,
      min_context_tokens: minContextTokens,
    },
    budget: task.budget,
    paid_consent: specialists.paid_consent === true,
  };
}

/**
 * Routes one launch. A specialist is only selected when the registry holds
 * promoted, verified evidence for it; every other outcome leaves the model
 * choice to the ordinary registry default. The decision is persisted by the
 * caller so the session stays pinned to it across resume.
 */
export async function routeLaunch(
  context: RequestContext,
  task: Pick<Task, "task_id" | "budget">,
  toolsRequired: boolean,
  specialists: WorkbenchSpecialists,
  minContextTokens: number,
  role: RoutingRequest["role"] = "worker",
  record?: (step: TaskRoutingStep) => Promise<void>,
): Promise<FrozenRouting> {
  if (specialists.steps) {
    const { routing, step } = await routeTaskStep(
      context,
      task,
      toolsRequired,
      specialists as WorkbenchSpecialists & { steps: SpecialistStepRouter },
      minContextTokens,
      role,
    );
    await record?.(step);
    if (!routing) throw new Error(`routing_${step.mode}`);
    return routing;
  }
  const decision = await specialists.router.route(
    context,
    routingRequest(task, toolsRequired, specialists, minContextTokens, role),
  );
  const selected =
    decision.outcome === "specialist" || decision.outcome === "baseline"
      ? decision.selected
      : null;
  const specialist =
    decision.outcome === "specialist" && selected ? selected : null;
  return FrozenRoutingSchema.parse({
    decision_id: decision.decision_id,
    routing_task_id: decision.task_id,
    outcome: decision.outcome,
    ref: selected?.ref ?? null,
    specialist_revision: specialist?.ref ?? null,
    // Only a verified specialist pins a model. Baseline and failed outcomes
    // keep the ordinary free-only default so routing can never widen paid use.
    model_id: specialist?.model_id ?? null,
  });
}

export interface RoutedTaskStep {
  /** Null when the step produced no decision (budget or deadline exhausted). */
  routing: FrozenRouting | null;
  step: TaskRoutingStep;
}

/** Routes one step of a task and freezes it like a launch decision. */
export async function routeTaskStep(
  context: RequestContext,
  task: Pick<Task, "task_id" | "budget">,
  toolsRequired: boolean,
  specialists: WorkbenchSpecialists & { steps: SpecialistStepRouter },
  minContextTokens: number,
  role: RoutingRequest["role"] = "worker",
  progress: Omit<TaskRoutingInput, "request"> = {},
): Promise<RoutedTaskStep> {
  const request = routingRequest(
    task,
    toolsRequired,
    specialists,
    minContextTokens,
    role,
  );
  const { step } = await specialists.steps.routeStep(context, {
    request,
    ...progress,
  });
  if (!step.decision_id || step.mode === "budget_exhausted") {
    return { routing: null, step };
  }
  const selected = step.selected;
  const specialist = selected?.kind === "specialist" ? selected : null;
  const outcome = selected ? selected.kind : "unavailable";
  return {
    step,
    routing: FrozenRoutingSchema.parse({
      decision_id: step.decision_id,
      routing_task_id: request.task_id,
      outcome,
      ref: selected?.ref ?? null,
      specialist_revision: specialist?.ref ?? null,
      model_id: specialist?.model_id ?? null,
    }),
  };
}

/** Task-evidence payload for one routing step (refs and reason codes only). */
export function routingStepEvidence(
  step: TaskRoutingStep,
  extra: { child_task_id?: string; phase: "launch" | "child" | "resume" },
): Record<string, unknown> {
  return {
    operation: "routing",
    status: step.mode,
    phase: extra.phase,
    ...(extra.child_task_id ? { child_task_id: extra.child_task_id } : {}),
    step: step.step,
    role: step.role,
    decision_id: step.decision_id,
    ref: step.selected?.ref ?? null,
    fallback_from: step.fallback_from,
    step_reasons: step.step_reasons,
    rejected: step.rejected,
    lost_refs: step.lost_refs,
  };
}
