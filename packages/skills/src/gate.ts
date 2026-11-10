import { createHash } from "node:crypto";
import { z } from "zod";
import { isQuarantined, type SkillOutcomeStats } from "./selection";

/** One held-out task run without and with the proposed skill. */
export interface GateRun {
  verified: boolean;
  cost_usd: number;
}

export interface GateTrial {
  task_id: string;
  baseline: GateRun;
  candidate: GateRun;
}

export interface SkillGateInput {
  proposal_id: string;
  /** Checked runs the proposal was learned from; never reused as held-out tasks. */
  evidence_task_ids: readonly string[];
  trials: readonly GateTrial[];
}

export interface SkillGateOptions {
  min_trials?: number;
  /** Held-out tasks the baseline passed and the candidate failed. */
  max_regressions?: number;
  /** One-sided exact sign test over discordant pairs. */
  alpha?: number;
  /** Candidate spend over baseline spend. */
  max_cost_ratio?: number;
}

export type SkillGateReason =
  | "evidence-missing"
  | "evidence-overlap"
  | "duplicate-trial"
  | "invalid-trial"
  | "too-few-trials"
  | "regression"
  | "not-significant"
  | "cost";

export interface SkillGateResult {
  proposal_id: string;
  passed: boolean;
  reasons: SkillGateReason[];
  trials: number;
  wins: number;
  losses: number;
  ties: number;
  baseline_rate: number;
  candidate_rate: number;
  p_value: number;
  cost_ratio: number;
  /** SHA-256 of the canonical input and options, so a verdict can be reproduced and audited. */
  digest: string;
  /** Thresholds the verdict was computed with; acceptance checks them against `GATE_POLICY`. */
  options: Required<SkillGateOptions>;
}

/** The loosest thresholds a verdict may use and still allow acceptance. */
export const GATE_POLICY: Readonly<Required<SkillGateOptions>> = Object.freeze({
  min_trials: 10,
  max_regressions: 0,
  alpha: 0.05,
  max_cost_ratio: 1.25,
});

/**
 * P(X >= wins) for X ~ Binomial(wins + losses, 1/2). Exact in doubles while
 * 2^n fits (so p = 1/64 compares equal to alpha = 1/64); log space beyond.
 */
export function signTestPValue(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1;
  if (n <= 1_000) {
    let coefficient = 1;
    let tail = 0;
    for (let k = 0; k <= n; k++) {
      if (k >= wins) tail += coefficient;
      coefficient = (coefficient * (n - k)) / (k + 1);
    }
    return Math.min(1, tail / 2 ** n);
  }
  let logCoefficient = 0;
  let tail = 0;
  for (let k = 0; k <= n; k++) {
    if (k >= wins) tail += Math.exp(logCoefficient - n * Math.LN2);
    logCoefficient += Math.log((n - k) / (k + 1));
  }
  return Math.min(1, tail);
}

function validRun(run: GateRun): boolean {
  return Number.isFinite(run.cost_usd) && run.cost_usd >= 0;
}

/**
 * Held-out A/B gate for a skill proposal: accept only when the candidate wins
 * significantly more paired tasks than it loses, never regresses beyond the
 * allowance, stays within the cost budget, and was not tested on the tasks it
 * was learned from.
 */
export function evaluateSkillGate(
  input: SkillGateInput,
  options: SkillGateOptions = {},
): SkillGateResult {
  const config = { ...GATE_POLICY, ...options };
  const reasons = new Set<SkillGateReason>();
  const evidence = new Set(
    input.evidence_task_ids.filter((id) => id.trim().length > 0),
  );
  if (!evidence.size) reasons.add("evidence-missing");
  const seen = new Set<string>();
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let baselinePassed = 0;
  let candidatePassed = 0;
  let baselineCost = 0;
  let candidateCost = 0;
  for (const trial of input.trials) {
    if (
      !trial.task_id ||
      !validRun(trial.baseline) ||
      !validRun(trial.candidate)
    )
      reasons.add("invalid-trial");
    if (evidence.has(trial.task_id)) reasons.add("evidence-overlap");
    if (seen.has(trial.task_id)) reasons.add("duplicate-trial");
    seen.add(trial.task_id);
    const before = trial.baseline.verified;
    const after = trial.candidate.verified;
    if (after && !before) wins++;
    else if (before && !after) losses++;
    else ties++;
    baselinePassed += before ? 1 : 0;
    candidatePassed += after ? 1 : 0;
    baselineCost += trial.baseline.cost_usd;
    candidateCost += trial.candidate.cost_usd;
  }
  const trials = input.trials.length;
  if (trials < config.min_trials) reasons.add("too-few-trials");
  if (losses > config.max_regressions) reasons.add("regression");
  const pValue = signTestPValue(wins, losses);
  if (!(pValue <= config.alpha)) reasons.add("not-significant");
  const costRatio =
    baselineCost > 0
      ? candidateCost / baselineCost
      : candidateCost > 0
        ? Number.POSITIVE_INFINITY
        : 1;
  if (costRatio > config.max_cost_ratio) reasons.add("cost");
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        input.proposal_id,
        [...evidence].sort(),
        // Sorted by the whole serialized trial so duplicate ids hash the same in any order.
        input.trials
          .map((t) =>
            JSON.stringify([
              t.task_id,
              t.baseline.verified,
              t.baseline.cost_usd,
              t.candidate.verified,
              t.candidate.cost_usd,
            ]),
          )
          .sort(),
        config,
      ]),
    )
    .digest("hex");
  return {
    proposal_id: input.proposal_id,
    passed: reasons.size === 0,
    reasons: [...reasons].sort(),
    trials,
    wins,
    losses,
    ties,
    baseline_rate: trials ? baselinePassed / trials : 0,
    candidate_rate: trials ? candidatePassed / trials : 0,
    p_value: pValue,
    cost_ratio: costRatio,
    digest,
    options: config,
  };
}

const GateRunSchema = z
  .object({
    verified: z.boolean(),
    cost_usd: z.number().finite().nonnegative(),
  })
  .strict();

/** A held-out trials file: one entry per task, run without and with the skill. */
export const GateTrialsSchema = z
  .array(
    z
      .object({
        task_id: z.string().trim().min(1).max(256),
        baseline: GateRunSchema,
        candidate: GateRunSchema,
      })
      .strict(),
  )
  .max(100_000);

/** Proposals that write skill instructions must pass the gate; archive, restore, pin and stale do not. */
export function gateRequired(ops: readonly { op: string }[]): boolean {
  return ops.some((op) => op.op === "create" || op.op === "update");
}

/** A passing verdict computed with thresholds no looser than `policy`. */
export function meetsGatePolicy(
  result: SkillGateResult,
  policy: Readonly<Required<SkillGateOptions>> = GATE_POLICY,
): boolean {
  const used = result.options;
  return (
    result.passed &&
    result.reasons.length === 0 &&
    used !== undefined &&
    used.min_trials >= policy.min_trials &&
    used.max_regressions <= policy.max_regressions &&
    used.alpha <= policy.alpha &&
    used.max_cost_ratio <= policy.max_cost_ratio
  );
}

export interface ArchivalCandidate {
  name: string;
  status: "active" | "stale" | "archived";
  pinned?: boolean;
}

/**
 * Archive proposals for skills that verified outcomes show lower the pass
 * rate. Proposals only: an operator still accepts them, nothing is deleted,
 * and pinned skills are left for the operator to decide.
 */
export function harmfulSkillArchivals(
  skills: readonly ArchivalCandidate[],
  stats: ReadonlyMap<string, SkillOutcomeStats>,
): {
  source: string;
  rationale: string;
  ops: { op: "archive"; name: string }[];
}[] {
  return skills
    .filter((skill) => skill.status !== "archived" && !skill.pinned)
    .filter((skill) => isQuarantined(stats.get(skill.name)))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((skill) => {
      const s = stats.get(skill.name) as SkillOutcomeStats;
      return {
        source: "outcome_gate",
        rationale: `Verified outcomes: ${s.verified}/${s.loads} tasks passed with ${skill.name} vs ${(s.baseline_rate * 100).toFixed(1)}% of ${s.baseline_loads} without it.`,
        ops: [{ op: "archive" as const, name: skill.name }],
      };
    });
}
