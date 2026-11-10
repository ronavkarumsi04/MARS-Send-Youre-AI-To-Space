import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Budget, RequestContext } from "@mars/contracts";
import { sha256 } from "@mars/contracts/canonical";
import {
  COMPARISON_MANIFEST_MEDIA_TYPE,
  type ComparisonManifest,
  type createEvaluationService,
  EvaluationReportSchema,
  HARBOR_VERSION,
  MINI_SWE_AGENT_VERSION,
  parseComparisonManifest,
} from "@mars/evaluation";
import { z } from "zod";
import { fail } from "./errors";
import type { AgentManifest, EvaluationOutcome, Split } from "./schemas";
import { canonicalJson, digestOf, seededRandom } from "./util";

/** Everything an evaluator is told about one evaluation. Built by the host. */
export interface EvaluationRequest {
  run_id: string;
  /** Archive candidate id, or `champion-<seq>` for the production champion. */
  subject_id: string;
  manifest: AgentManifest;
  manifest_sha256: string;
  /** Host-owned read-only copy of the built bundle (never the candidate workspace). */
  bundle_dir: string;
  bundle_sha256: string;
  split: Split;
  family: string | null;
  tasks: string[];
  repeats: number;
  /** Shared by both arms of a comparison so noise is paired (common random numbers). */
  seed: string;
  budget: Budget;
  deadline_ms: number;
}

/**
 * The acceptance evaluator. It runs in the host process (or behind
 * `@mars/evaluation`), never inside a candidate workspace; its identity is
 * pinned by `digest` when a run starts and re-checked on every outcome.
 */
export interface CandidateEvaluator {
  readonly digest: string;
  readonly simulated: boolean;
  evaluate(
    request: EvaluationRequest,
    signal: AbortSignal,
  ): Promise<EvaluationOutcome>;
}

const FixturePolicySchema = z
  .object({
    /** Per-task solve probability; anything else uses `default`. */
    solve: z.record(z.number().min(0).max(1)).default({}),
    default: z.number().min(0).max(1).default(0),
    /** Fake effort knob; the evaluator (not the candidate) turns it into cost. */
    effort: z.number().min(0).max(100).default(1),
  })
  .strict();

export const FIXTURE_POLICY_FILE = "fixture-policy.json";

/**
 * FAKE evaluator for offline tests: reads `fixture-policy.json` from the built
 * bundle and draws Bernoulli rewards from a seeded PRNG keyed by
 * (seed, task, repeat), so paired arms share their noise. Makes no model
 * requests (`model_requests: 0` is recorded in notes) and reports
 * `simulated: true`; it is never evidence of real task-solving ability.
 */
export function createFixtureEvaluator(
  options: { usdPerTrialPerEffort?: number; baselineSolve?: number } = {},
): CandidateEvaluator {
  const usd = options.usdPerTrialPerEffort ?? 0.01;
  const digest = digestOf({
    kind: "mars.fixture-evaluator/v1",
    usd,
    baseline: options.baselineSolve ?? null,
  });
  return {
    digest,
    simulated: true,
    async evaluate(request, signal) {
      if (signal.aborted) fail("deadline_exceeded", "evaluation aborted");
      const started = Date.now();
      const raw = await readFile(
        join(request.bundle_dir, FIXTURE_POLICY_FILE),
        "utf8",
      ).catch(() => "{}");
      const parsed = FixturePolicySchema.safeParse(JSON.parse(raw));
      const policy = parsed.success
        ? parsed.data
        : FixturePolicySchema.parse({});
      const per_task = request.tasks.map((task_id) => {
        const p = policy.solve[task_id] ?? policy.default;
        const rewards = Array.from({ length: request.repeats }, (_, repeat) =>
          seededRandom(`${request.seed}\0${task_id}\0${repeat}`)() < p ? 1 : 0,
        );
        const baseline_rewards =
          options.baselineSolve === undefined
            ? null
            : Array.from({ length: request.repeats }, (_, repeat) =>
                seededRandom(
                  `${request.seed}\0baseline\0${task_id}\0${repeat}`,
                )() < (options.baselineSolve ?? 0)
                  ? 1
                  : 0,
              );
        return { task_id, rewards, baseline_rewards };
      });
      const trials = request.tasks.length * request.repeats;
      return {
        evaluator_digest: digest,
        simulated: true,
        per_task,
        cost_usd: Number((trials * usd * policy.effort).toFixed(6)),
        tokens: 0,
        runtime_ms: Date.now() - started,
        report: null,
        notes: ["fake fixture evaluator", "model_requests: 0"],
      };
    },
  };
}

export interface HarborEvaluatorOptions {
  service: ReturnType<typeof createEvaluationService>;
  artifacts: {
    put(
      context: RequestContext,
      data: Uint8Array,
      mediaType: string,
    ): Promise<import("@mars/contracts").ArtifactRef>;
    get(
      context: RequestContext,
      ref: import("@mars/contracts").ArtifactRef,
    ): Promise<Uint8Array>;
  };
  context: RequestContext;
  /**
   * Host-owned comparison template (dataset pin, images, model pin, timeouts).
   * Its tasks/repeats/arms/budget are replaced per evaluation; its model id
   * must equal the run's frozen manifest model id.
   */
  template: ComparisonManifest;
  /** Optional evaluator-config files whose bytes are part of the pinned digest. */
  configDigest?: string;
}

/**
 * Adapter onto `@mars/evaluation`: every candidate (and the champion) runs as
 * the MARS arm of a Harbor comparison against the mini-swe-agent baseline,
 * with the same manifest-level budget, dataset pin, images and model.
 */
export function createHarborEvaluator(
  options: HarborEvaluatorOptions,
): CandidateEvaluator {
  const { template } = options;
  const digest = digestOf({
    kind: "mars.harbor-evaluator/v1",
    harbor: HARBOR_VERSION,
    mini_swe_agent: MINI_SWE_AGENT_VERSION,
    dataset: template.dataset,
    environment: template.environment,
    model: template.model,
    timeouts: template.timeouts,
    per_trial: template.per_trial,
    config: options.configDigest ?? null,
  });
  return {
    digest,
    simulated: false,
    async evaluate(request, signal) {
      if (request.manifest.model.id !== template.model.id)
        fail(
          "evaluator_mismatch",
          `manifest model ${request.manifest.model.id} ≠ evaluator model ${template.model.id}`,
        );
      // @mars/evaluation pins the agent binary itself, not the bundle tree digest.
      const agentSha256 = sha256(
        new Uint8Array(
          await readFile(join(request.bundle_dir, "mars-agent")).catch(() =>
            fail("build_failed", "candidate bundle has no mars-agent binary"),
          ),
        ),
      );
      const comparison = parseComparisonManifest({
        ...template,
        comparison_id: `evo-${digestOf([request.run_id, request.subject_id, request.split, request.seed]).slice(0, 24)}`,
        tasks: request.tasks,
        final_holdout_tasks: request.split === "final" ? request.tasks : [],
        repeats: request.repeats,
        budget: request.budget,
        arms: {
          baseline: template.arms.baseline,
          candidate: {
            ...template.arms.candidate,
            candidate: {
              candidate_id: request.subject_id,
              components: {
                ...request.manifest.prompts,
                // Non-prompt settings must reach the evaluated agent too, or a
                // tool/skill/retrieval mutation would score the old configuration.
                mars_agent_settings: canonicalJson({
                  model: request.manifest.model,
                  skills: request.manifest.skills,
                  tools: request.manifest.tools,
                  retrieval: request.manifest.retrieval,
                }),
              },
              parent_candidate_id: null,
              created_at: template.created_at,
            },
            bundle: { path: request.bundle_dir, sha256: agentSha256 },
          },
        },
      });
      const ref = await options.artifacts.put(
        options.context,
        new TextEncoder().encode(canonicalJson(comparison)),
        COMPARISON_MANIFEST_MEDIA_TYPE,
      );
      const started = Date.now();
      const job = await options.service.submitComparison(
        options.context,
        ref,
        request.budget,
      );
      const onAbort = () =>
        void options.service
          .cancel(options.context, job.job_id)
          .catch(() => {});
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        await options.service.settled(job.job_id);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
      const result = await options.service.inspect(options.context, job.job_id);
      if (result.status !== "completed" || !result.artifacts[0])
        fail(
          signal.aborted ? "deadline_exceeded" : "build_failed",
          `evaluation job ${result.status}`,
        );
      const report = EvaluationReportSchema.parse(
        JSON.parse(
          new TextDecoder().decode(
            await options.artifacts.get(options.context, result.artifacts[0]),
          ),
        ),
      );
      const pad = (rewards: number[], trials: number) => [
        ...rewards.map((reward) => Math.max(0, Math.min(1, reward))),
        ...Array.from(
          {
            length: Math.max(
              0,
              Math.max(trials, request.repeats) - rewards.length,
            ),
          },
          () => null,
        ),
      ];
      const byTask = new Map(report.per_task.map((row) => [row.task_id, row]));
      const arm = report.arms.candidate;
      return {
        evaluator_digest: digest,
        simulated: false,
        per_task: request.tasks.map((task_id) => {
          const row = byTask.get(task_id);
          return {
            task_id,
            rewards: row
              ? pad(row.candidate.rewards, row.candidate.n_trials).slice(
                  0,
                  request.repeats,
                )
              : Array.from({ length: request.repeats }, () => null),
            baseline_rewards: row
              ? pad(row.baseline.rewards, row.baseline.n_trials).slice(
                  0,
                  request.repeats,
                )
              : null,
          };
        }),
        cost_usd: arm.total_cost_usd,
        tokens: tokensOf(arm),
        baseline_cost_usd: report.arms.baseline.total_cost_usd,
        baseline_tokens: tokensOf(report.arms.baseline),
        runtime_ms: Date.now() - started,
        report: result.artifacts[0],
        notes: [`harbor job ${job.job_id}`],
      };
    },
  };
}

function tokensOf(arm: {
  n_input_tokens: number | null;
  n_output_tokens: number | null;
}): number | null {
  return arm.n_input_tokens === null || arm.n_output_tokens === null
    ? null
    : Math.round(arm.n_input_tokens + arm.n_output_tokens);
}
