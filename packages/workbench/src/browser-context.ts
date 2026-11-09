import {
  type BrowserAction,
  BrowserActionSchema,
  type BrowserJobView,
  type BrowserPolicyAction,
  type BrowserStep,
  DEFAULT_ALLOWED_ACTIONS,
  type DurableBrowserService,
} from "@mars/browser";
import type { RequestContext, Task } from "@mars/contracts";
import type { RuntimeBrowser } from "@mars/execution";
import { untrustedText } from "./untrusted-render";

/** The parent-owned browser service surface the workbench uses. */
export type WorkbenchBrowser = Pick<
  DurableBrowserService,
  "submit" | "inspect" | "readResult" | "markStale" | "reconcileTask"
> &
  Partial<Pick<DurableBrowserService, "allowance" | "ownsEvidence">>;

/** Default browser-task deadline after submission, bounded by the task's remaining time. */
export const BROWSER_DEADLINE_MS = 5 * 60 * 1000;
export const DEFAULT_BROWSER_MAX_STEPS = 20;
const MAX_FIELD_CHARS = 1024;
const MAX_EXTRACT_CHARS = 16 * 1024;
const MAX_RENDERED_STEPS = 50;

/**
 * Parses the compact action strings the model passes to mars_browse
 * ("click e3", "type e2 hello", "navigate https://…") into strict actions.
 */
export function parseBrowserActionCommand(command: string): BrowserAction {
  const trimmed = command.trim();
  const space = trimmed.indexOf(" ");
  const verb = (space < 0 ? trimmed : trimmed.slice(0, space)).toLowerCase();
  const rest = space < 0 ? "" : trimmed.slice(space + 1).trim();
  let candidate: unknown;
  switch (verb) {
    case "navigate":
      candidate = { type: verb, url: rest };
      break;
    case "click":
      candidate = { type: verb, ref: rest };
      break;
    case "type": {
      const gap = rest.indexOf(" ");
      candidate =
        gap < 0
          ? { type: verb }
          : { type: verb, ref: rest.slice(0, gap), text: rest.slice(gap + 1) };
      break;
    }
    case "press":
      candidate = { type: verb, key: rest };
      break;
    case "scroll":
      candidate = { type: verb, direction: rest.toLowerCase() };
      break;
    case "back":
    case "screenshot":
    case "extract":
      candidate = rest ? { type: verb, extra: rest } : { type: verb };
      break;
    default:
      candidate = { type: "unknown" };
  }
  const parsed = BrowserActionSchema.safeParse(candidate);
  if (!parsed.success || parsed.data.type === "done")
    throw new Error(`Invalid browser action: ${untrustedText(trimmed, 80)}`);
  return parsed.data;
}

function describeAction(action: BrowserAction): string {
  switch (action.type) {
    case "navigate":
      return `navigate ${untrustedText(action.url, 256)}`;
    case "click":
      return `click ${action.ref}`;
    case "type":
      return `type into ${action.ref} (${action.text.length} chars)`;
    case "press":
      return `press ${action.key}`;
    case "scroll":
      return `scroll ${action.direction}`;
    case "done":
      return `done (${action.success ? "success" : "failure"})`;
    default:
      return action.type;
  }
}

function renderStep(step: BrowserStep): string {
  const refs = step.artifacts.map((ref) => ref.artifact_id).join(", ");
  return [
    `${step.index + 1}. ${describeAction(step.action)} -> ${step.outcome}`,
    step.detail ? ` · ${untrustedText(step.detail, MAX_FIELD_CHARS)}` : "",
    step.title ? ` · page "${untrustedText(step.title, 200)}"` : "",
    step.url ? ` · ${untrustedText(step.url, 512)}` : "",
    refs ? ` · artifacts ${refs}` : "",
  ].join("");
}

/** Renders a browser job as clearly untrusted web content. */
export function renderBrowserJob(
  view: BrowserJobView,
  currentRevision: number,
): string {
  const { job, steps, result } = view;
  const stale = job.stale || job.task_revision !== currentRevision;
  const lines = [
    `Browser request ${job.request_id}: ${job.status}${stale ? " (stale: the task changed since it was queued)" : ""}${job.error_code ? ` (${job.error_code})` : ""}, attempt ${job.attempts} of ${job.max_attempts}, ${steps.length} step(s).`,
  ];
  if (steps.length > 0) {
    lines.push("[untrusted browser steps]");
    lines.push(...steps.slice(0, MAX_RENDERED_STEPS).map(renderStep));
    if (steps.length > MAX_RENDERED_STEPS)
      lines.push(
        `${steps.length - MAX_RENDERED_STEPS} more step(s) not shown.`,
      );
  }
  if (result) {
    lines.push(
      `[untrusted browser result · ${result.success ? "succeeded" : "did not succeed"}]`,
      `Summary: ${untrustedText(result.summary, 4096)}`,
      `Final URL: ${untrustedText(result.final_url, 512)}`,
    );
    if (result.extracted !== undefined)
      lines.push(
        `Extracted page text: ${untrustedText(result.extracted, MAX_EXTRACT_CHARS)}`,
      );
    if (result.artifacts.length > 0)
      lines.push(
        `Artifacts: ${result.artifacts.map((ref) => `${ref.artifact_id} (${ref.media_type})`).join(", ")}`,
      );
  }
  return lines.join("\n");
}

/** Supersedes a task's browser jobs after its instructions change; best-effort. */
export async function staleTaskBrowser(
  service: WorkbenchBrowser,
  context: RequestContext,
  task: () => Promise<Task>,
): Promise<void> {
  try {
    const current = await task();
    await service.markStale(context, current.task_id, current.revision);
  } catch {
    // Rendering compares revisions, so an unmarked job still renders as stale.
  }
}

/**
 * Binds the session's browser tools to the parent-owned service host-side.
 * Jobs are scoped to the task and its current durable revision, sized inside
 * the task's shared allowance, and the model only sees rendered untrusted text.
 */
export function browserTools(
  service: WorkbenchBrowser,
  context: () => RequestContext,
  currentTask: () => Promise<Task>,
  taskDeadline: () => number,
  now: () => number = Date.now,
): RuntimeBrowser {
  return {
    async submit(input) {
      const task = await currentTask();
      const remaining = taskDeadline() - now();
      if (remaining <= 0)
        throw new Error(
          "The task deadline has passed; browser tasks cannot be queued.",
        );
      const deadline = new Date(
        now() + Math.min(BROWSER_DEADLINE_MS, remaining),
      ).toISOString();
      const actions = input.actions?.map(parseBrowserActionCommand);
      const allowed = new Set<string>(
        input.allowed_actions ?? DEFAULT_ALLOWED_ACTIONS,
      );
      if (!input.allowed_actions)
        for (const action of actions ?? []) allowed.add(action.type);
      // Half of what the task still holds, as research does: the foreground
      // run and later background work keep room of their own.
      const left = await service.allowance?.(context(), task.task_id);
      const budget = left
        ? {
            ...task.budget,
            max_tokens: Math.min(
              task.budget.max_tokens,
              Math.floor(left.max_tokens / 2),
            ),
            max_usd: Math.min(task.budget.max_usd, left.max_usd / 2),
          }
        : task.budget;
      if (budget.max_tokens < 1)
        throw new Error(
          "The task's browser allowance is used up; no more browser tasks can be queued.",
        );
      const job = await service.submit(context(), {
        goal: input.goal,
        task_id: task.task_id,
        task_revision: task.revision,
        start_url: input.start_url,
        ...(actions ? { actions } : {}),
        allowed_actions: [...allowed] as BrowserPolicyAction[],
        ...(input.session_key ? { session_key: input.session_key } : {}),
        max_steps: Math.max(
          input.max_steps ?? DEFAULT_BROWSER_MAX_STEPS,
          actions?.length ?? 0,
        ),
        deadline,
        budget,
      });
      return `Queued browser request ${job.request_id} (deadline ${deadline}). Read its result later with mars_browse_result.`;
    },
    async result(requestId) {
      const task = await currentTask();
      const job = await service.inspect(context(), requestId);
      if (job.task_id !== task.task_id)
        throw new Error("Unknown browser request for this task.");
      return renderBrowserJob(
        await service.readResult(context(), requestId),
        task.revision,
      );
    },
  };
}
