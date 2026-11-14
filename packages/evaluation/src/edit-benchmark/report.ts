import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson, sha256 } from "@mars/contracts/canonical";
import {
  EDIT_FORMAT_EVIDENCE_SCHEMA,
  type EditFormatEvidence,
} from "@mars/execution";
import { z } from "zod";
import { type EditBenchmarkArm, OMP_STOCK_ARM, type TrialResult } from "./arms";
import { MIN_POWERED_TASKS } from "./power";
import {
  bootstrapRatio,
  exactSignTest,
  holmAdjust,
  type RatioInterval,
  wilsonInterval,
} from "./stats";

export const EDIT_BENCHMARK_REPORT_SCHEMA = "mars.edit-benchmark-report/v1";

/**
 * The success bar, fixed in documentation/EVALUATION.md before any live run
 * (amended 2026-11-14, still before any live data): the MARS arm in the
 * model's static default format, fixed before the run, must beat omp-stock
 * on verified solve rate with p < 0.05 on the paired exact sign test, and
 * its cost per verified solve must not be worse. One confirmatory test, so
 * no multiplicity correction; other arms are secondary. The verdict is
 * reported whichever way it goes.
 */
export const PREREGISTERED_BAR = {
  id: "mars-vs-omp-stock/v2",
  alpha: 0.05,
  statement:
    "MARS's default edit format for that model beats omp-stock on host-verified solve rate for small models with p < 0.05 on the paired exact sign test over tasks, and its cost per verified solve is not worse (USD when either arm is priced, else total tokens).",
} as const;

export const SECONDARY_LABEL =
  "secondary (exploratory, not adjusted for multiple comparisons)";

/** The pre-registered candidate: fixed from the model before any trial runs. */
export interface ConfirmatoryArm {
  arm: EditBenchmarkArm;
  reason: "static_default";
}

export interface ArmSummary {
  arm: EditBenchmarkArm;
  edit_modes: string[];
  trials: number;
  verified_solves: number;
  solve_rate: number;
  solve_rate_wilson95: { lower: number; upper: number };
  edit_calls: number;
  edit_failures: number;
  edit_failure_rate: number | null;
  turns_mean: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  cost_per_verified_solve_usd: RatioInterval;
  tokens_per_verified_solve: RatioInterval;
  wall_ms_total: number;
  wall_ms_mean: number;
  network_refusals: number;
  path_refusals: number;
}

export interface PairedComparison {
  candidate: EditBenchmarkArm;
  baseline: typeof OMP_STOCK_ARM;
  unit: "task";
  tasks: number;
  both_solved: number;
  neither_solved: number;
  candidate_only: string[];
  baseline_only: string[];
  sign_test: ReturnType<typeof exactSignTest>;
}

export interface BarVerdict {
  bar_id: string;
  /** Always the confirmatory arm when it ran; never chosen from results. */
  candidate: EditBenchmarkArm | null;
  confirmatory_arm: EditBenchmarkArm;
  confirmatory_reason: ConfirmatoryArm["reason"];
  solve_rate_better: boolean;
  significant: boolean;
  cost_basis: "usd" | "tokens";
  cost_not_worse: boolean | null;
  met: boolean;
  /** True when the suite is below the power-analysis minimum: no verdict is computed. */
  exploratory: boolean;
  suite_tasks: number;
  min_powered_tasks: number;
  summary: string;
}

/** Per-task pass for paired analysis: a strict majority of its repeats solved. */
function taskSolved(rows: readonly TrialResult[]): boolean {
  return rows.filter((row) => row.solved).length * 2 > rows.length;
}

export function summarizeArm(
  arm: EditBenchmarkArm,
  trials: readonly TrialResult[],
  seed: string,
): ArmSummary {
  const rows = trials.filter((trial) => trial.arm === arm);
  const solves = rows.filter((row) => row.solved).length;
  const sum = (pick: (row: TrialResult) => number) =>
    rows.reduce((total, row) => total + pick(row), 0);
  const byTask = new Map<string, TrialResult[]>();
  for (const row of rows)
    byTask.set(row.task_id, [...(byTask.get(row.task_id) ?? []), row]);
  const units = (value: (row: TrialResult) => number) =>
    [...byTask.values()].map((taskRows) => ({
      numerator: taskRows.reduce((total, row) => total + value(row), 0),
      denominator: taskRows.filter((row) => row.solved).length,
    }));
  const editCalls = sum((row) => row.edit_calls);
  return {
    arm,
    edit_modes: [...new Set(rows.map((row) => row.edit_mode))].sort(),
    trials: rows.length,
    verified_solves: solves,
    solve_rate: rows.length === 0 ? 0 : solves / rows.length,
    solve_rate_wilson95: wilsonInterval(solves, rows.length),
    edit_calls: editCalls,
    edit_failures: sum((row) => row.edit_failures),
    edit_failure_rate:
      editCalls === 0 ? null : sum((row) => row.edit_failures) / editCalls,
    turns_mean: rows.length === 0 ? 0 : sum((row) => row.turns) / rows.length,
    input_tokens: sum((row) => row.input_tokens),
    output_tokens: sum((row) => row.output_tokens),
    cost_usd: sum((row) => row.cost_usd),
    cost_per_verified_solve_usd: bootstrapRatio(
      units((row) => row.cost_usd),
      { seed: `${seed}:${arm}:usd` },
    ),
    tokens_per_verified_solve: bootstrapRatio(
      units((row) => row.input_tokens + row.output_tokens),
      { seed: `${seed}:${arm}:tokens` },
    ),
    wall_ms_total: sum((row) => row.wall_ms),
    wall_ms_mean:
      rows.length === 0 ? 0 : sum((row) => row.wall_ms) / rows.length,
    network_refusals: sum((row) => row.network_refusals),
    path_refusals: sum((row) => row.path_refusals),
  };
}

/** Best MARS arm: highest verified solve rate, ties broken by lower cost per solve. */
export function bestMarsArm(arms: readonly ArmSummary[]): ArmSummary | null {
  const mars = arms.filter((arm) => arm.arm !== OMP_STOCK_ARM);
  const cost = (arm: ArmSummary) =>
    arm.cost_per_verified_solve_usd.estimate ??
    arm.tokens_per_verified_solve.estimate ??
    Number.POSITIVE_INFINITY;
  return (
    [...mars].sort(
      (a, b) =>
        b.solve_rate - a.solve_rate ||
        cost(a) - cost(b) ||
        (a.arm < b.arm ? -1 : 1),
    )[0] ?? null
  );
}

export function pairedComparison(
  candidate: EditBenchmarkArm,
  trials: readonly TrialResult[],
): PairedComparison {
  const tasks = [...new Set(trials.map((trial) => trial.task_id))].sort();
  const solved = (arm: EditBenchmarkArm, task: string) =>
    taskSolved(trials.filter((t) => t.arm === arm && t.task_id === task));
  const candidateOnly: string[] = [];
  const baselineOnly: string[] = [];
  let both = 0;
  let neither = 0;
  for (const task of tasks) {
    const a = solved(candidate, task);
    const b = solved(OMP_STOCK_ARM, task);
    if (a && b) both += 1;
    else if (!a && !b) neither += 1;
    else if (a) candidateOnly.push(task);
    else baselineOnly.push(task);
  }
  return {
    candidate,
    baseline: OMP_STOCK_ARM,
    unit: "task",
    tasks: tasks.length,
    both_solved: both,
    neither_solved: neither,
    candidate_only: candidateOnly,
    baseline_only: baselineOnly,
    sign_test: exactSignTest(candidateOnly.length, baselineOnly.length),
  };
}

/**
 * The pre-registered verdict for the confirmatory arm only. A missing
 * confirmatory arm is "not evaluable"; it never falls back to another arm.
 */
export function judgeBar(input: {
  confirmatory: ConfirmatoryArm;
  arms: readonly ArmSummary[];
  paired: PairedComparison | null;
  suiteTasks: number;
}): BarVerdict {
  const { confirmatory, paired, suiteTasks } = input;
  const candidate = input.arms.find((arm) => arm.arm === confirmatory.arm);
  const baseline = input.arms.find((arm) => arm.arm === OMP_STOCK_ARM);
  const power = {
    confirmatory_arm: confirmatory.arm,
    confirmatory_reason: confirmatory.reason,
    exploratory: suiteTasks < MIN_POWERED_TASKS,
    suite_tasks: suiteTasks,
    min_powered_tasks: MIN_POWERED_TASKS,
  };
  if (!candidate || !baseline || !paired || paired.candidate !== candidate.arm)
    return {
      ...power,
      bar_id: PREREGISTERED_BAR.id,
      candidate: null,
      solve_rate_better: false,
      significant: false,
      cost_basis: "tokens",
      cost_not_worse: null,
      met: false,
      summary: !candidate
        ? `Not evaluable: confirmatory arm ${confirmatory.arm} not run.`
        : "Not evaluable: omp-stock did not run.",
    };
  const priced = candidate.cost_usd > 0 || baseline.cost_usd > 0;
  const pick = (arm: ArmSummary) =>
    priced
      ? arm.cost_per_verified_solve_usd.estimate
      : arm.tokens_per_verified_solve.estimate;
  const mine = pick(candidate);
  const theirs = pick(baseline);
  const costNotWorse =
    mine === null ? false : theirs === null ? true : mine <= theirs;
  const better =
    paired.candidate_only.length > paired.baseline_only.length &&
    candidate.solve_rate > baseline.solve_rate;
  const significant =
    better && paired.sign_test.p_two_sided < PREREGISTERED_BAR.alpha;
  const p = paired.sign_test.p_two_sided.toPrecision(3);
  if (power.exploratory)
    return {
      ...power,
      bar_id: PREREGISTERED_BAR.id,
      candidate: candidate.arm,
      solve_rate_better: better,
      significant: false,
      cost_basis: priced ? "usd" : "tokens",
      cost_not_worse: costNotWorse,
      met: false,
      summary: `Exploratory: the suite has ${suiteTasks} task(s), below the power-analysis minimum of ${MIN_POWERED_TASKS}, so the pre-registered verdict is not computed (${candidate.arm} vs omp-stock: ${paired.candidate_only.length} vs ${paired.baseline_only.length} discordant tasks, p = ${p}).`,
    };
  const met = significant && costNotWorse;
  return {
    ...power,
    bar_id: PREREGISTERED_BAR.id,
    candidate: candidate.arm,
    solve_rate_better: better,
    significant,
    cost_basis: priced ? "usd" : "tokens",
    cost_not_worse: costNotWorse,
    met,
    summary: met
      ? `Bar met: ${candidate.arm} beats omp-stock (${paired.candidate_only.length} vs ${paired.baseline_only.length} discordant tasks, p = ${p}) at no worse cost per verified solve.`
      : `Bar not met: ${candidate.arm} vs omp-stock — ${paired.candidate_only.length} vs ${paired.baseline_only.length} discordant tasks, p = ${p}; solve rate ${better ? "higher" : "not higher"}, cost per verified solve ${costNotWorse ? "not worse" : "worse"}.`,
  };
}

export interface SecondaryComparison {
  arm: EditBenchmarkArm;
  confirmatory: boolean;
  paired: PairedComparison;
  p_raw: number;
  /** Holm-adjusted across every MARS-vs-omp-stock comparison in the run. */
  p_holm: number;
}

export interface SecondaryComparisons {
  label: typeof SECONDARY_LABEL;
  adjustment: "holm";
  /** Highest verified solve rate (ties: lower cost per solve); descriptive only. */
  best_arm: EditBenchmarkArm | null;
  comparisons: SecondaryComparison[];
}

/** Every MARS arm vs omp-stock, raw and Holm-adjusted; never a verdict. */
export function secondaryComparisons(
  arms: readonly ArmSummary[],
  trials: readonly TrialResult[],
  confirmatory: EditBenchmarkArm,
): SecondaryComparisons {
  const mars = arms.filter((arm) => arm.arm !== OMP_STOCK_ARM);
  const paired = mars.map((arm) => pairedComparison(arm.arm, trials));
  const holm = holmAdjust(paired.map((p) => p.sign_test.p_two_sided));
  return {
    label: SECONDARY_LABEL,
    adjustment: "holm",
    best_arm: bestMarsArm(arms)?.arm ?? null,
    comparisons: paired.map((p, index) => ({
      arm: p.candidate,
      confirmatory: p.candidate === confirmatory,
      paired: p,
      p_raw: p.sign_test.p_two_sided,
      p_holm: holm[index] ?? 1,
    })),
  };
}

export const EditBenchmarkReportSchema = z
  .object({
    schema: z.literal(EDIT_BENCHMARK_REPORT_SCHEMA),
    report_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    attestation: z
      .object({
        alg: z.literal("hmac-sha256"),
        key_id: z.string().min(1),
        mac_hex: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
  })
  .passthrough();

export type EditBenchmarkReport = Record<string, unknown> & {
  schema: typeof EDIT_BENCHMARK_REPORT_SCHEMA;
  report_sha256: string;
  attestation?: { alg: "hmac-sha256"; key_id: string; mac_hex: string };
};

/** `report_sha256` is sha256 of the canonical JSON of the report without it and the attestation. */
export function sealReport(
  unsigned: Record<string, unknown>,
  signer?: { key_id: string; secret: Uint8Array },
): EditBenchmarkReport {
  const body = {
    ...unsigned,
    schema: EDIT_BENCHMARK_REPORT_SCHEMA as typeof EDIT_BENCHMARK_REPORT_SCHEMA,
  };
  const report_sha256 = sha256(canonicalJson(body));
  const sealed: EditBenchmarkReport = { ...body, report_sha256 };
  if (!signer) return sealed;
  const mac_hex = createHmac("sha256", Uint8Array.from(signer.secret))
    .update(canonicalJson(sealed))
    .digest("hex");
  return {
    ...sealed,
    attestation: { alg: "hmac-sha256", key_id: signer.key_id, mac_hex },
  };
}

/**
 * Re-derives the digest (and, with `trust`, checks the HMAC). Throws on any
 * mismatch; an unsigned report is refused when `trust` is given.
 */
export function verifyEditBenchmarkReport(
  value: unknown,
  trust?: { key_id: string; secret: Uint8Array },
): EditBenchmarkReport {
  const parsed = EditBenchmarkReportSchema.parse(value) as EditBenchmarkReport;
  const { report_sha256, attestation, ...body } = parsed;
  if (sha256(canonicalJson(body)) !== report_sha256)
    throw new Error("report_digest_mismatch");
  if (trust) {
    if (!attestation || attestation.key_id !== trust.key_id)
      throw new Error("report_unsigned");
    const expected = createHmac("sha256", Uint8Array.from(trust.secret))
      .update(canonicalJson({ ...body, report_sha256 }))
      .digest();
    const actual = Buffer.from(attestation.mac_hex, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new Error("report_signature_invalid");
  }
  return parsed;
}

const ReportViewSchema = z
  .object({
    simulated: z.boolean(),
    generated_at: z.string().min(1),
    repository: z.string().min(1),
    model: z.object({ id: z.string().min(1) }).passthrough(),
    arms: z.array(
      z
        .object({
          arm: z.string(),
          trials: z.number().int().nonnegative(),
          verified_solves: z.number().int().nonnegative(),
          solve_rate: z.number().min(0).max(1),
          cost_per_verified_solve_usd: z
            .object({ estimate: z.number().nullable() })
            .passthrough(),
          tokens_per_verified_solve: z
            .object({ estimate: z.number().nullable() })
            .passthrough(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

/** Selection evidence for `selectEditFormat` from an already verified report. */
export function editFormatEvidenceFromReport(
  report: EditBenchmarkReport,
): EditFormatEvidence {
  const view = ReportViewSchema.parse(report);
  return {
    schema: EDIT_FORMAT_EVIDENCE_SCHEMA,
    report_sha256: report.report_sha256,
    model_id: view.model.id,
    repository: view.repository,
    generated_at: view.generated_at,
    simulated: view.simulated,
    arms: view.arms
      .filter((arm) => arm.arm.startsWith("mars:"))
      .map((arm) => ({
        format: arm.arm.slice("mars:".length),
        trials: arm.trials,
        verified_solves: arm.verified_solves,
        solve_rate: arm.solve_rate,
        cost_per_verified_solve_usd: arm.cost_per_verified_solve_usd.estimate,
        tokens_per_verified_solve: arm.tokens_per_verified_solve.estimate,
      })),
  };
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const num = (value: number | null, digits = 4) =>
  value === null ? "n/a" : value.toFixed(digits);

/** Human-readable summary of a sealed report. */
export function renderEditBenchmarkMarkdown(
  report: EditBenchmarkReport,
): string {
  const r = report as unknown as {
    simulated: boolean;
    generated_at: string;
    repository: string;
    model: { id: string };
    seed: { job: string; serving: number };
    suite: {
      suite_id: string;
      revision: string;
      sha256: string;
      tasks: number;
    };
    repeats: number;
    budget_per_task: {
      max_tokens: number;
      max_usd: number;
      max_duration_ms: number;
    };
    arms: ArmSummary[];
    paired: PairedComparison | null;
    secondary?: SecondaryComparisons;
    verdict: BarVerdict;
    limitations: string[];
  };
  const lines = [
    `# Edit-format benchmark: ${r.model.id}`,
    "",
    r.simulated
      ? "> **SIMULATED** — scripted fake models, zero real model calls. Not evidence about any real model."
      : "> Live run against a real model endpoint.",
    "",
    `- Report sha256: \`${report.report_sha256}\`${report.attestation ? ` (HMAC key \`${report.attestation.key_id}\`)` : " (unsigned)"}`,
    `- Generated: ${r.generated_at}; repository \`${r.repository}\``,
    `- Suite: \`${r.suite.suite_id}@${r.suite.revision}\` (${r.suite.tasks} tasks, sha256 \`${r.suite.sha256.slice(0, 16)}…\`), ${r.repeats} repeat(s), seed \`${r.seed.job.slice(0, 16)}…\` (serving seed ${r.seed.serving})`,
    `- Budget per task: ${r.budget_per_task.max_tokens} tokens, $${r.budget_per_task.max_usd}, ${r.budget_per_task.max_duration_ms} ms`,
    "",
    "| Arm | Edit mode | Solve rate (Wilson 95%) | Edit-call failures | Turns | In / out tokens | Cost / verified solve (95% CI) | Tokens / verified solve | Wall time |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...r.arms.map(
      (arm) =>
        `| ${arm.arm} | ${arm.edit_modes.join(", ")} | ${arm.verified_solves}/${arm.trials} = ${pct(arm.solve_rate)} (${pct(arm.solve_rate_wilson95.lower)}–${pct(arm.solve_rate_wilson95.upper)}) | ${arm.edit_failures}/${arm.edit_calls}${arm.edit_failure_rate === null ? "" : ` (${pct(arm.edit_failure_rate)})`} | ${arm.turns_mean.toFixed(1)} | ${arm.input_tokens} / ${arm.output_tokens} | $${num(arm.cost_per_verified_solve_usd.estimate, 6)} (${num(arm.cost_per_verified_solve_usd.low, 6)}–${num(arm.cost_per_verified_solve_usd.high, 6)}) | ${num(arm.tokens_per_verified_solve.estimate, 0)} | ${(arm.wall_ms_total / 1000).toFixed(1)} s |`,
    ),
    "",
    "## Confirmatory comparison (per task, majority of repeats)",
    "",
    `Pre-registered arm: ${r.verdict.confirmatory_arm} (${r.verdict.confirmatory_reason}: the model's default edit format, fixed before the run).`,
    "",
    r.paired
      ? `${r.paired.candidate} vs omp-stock over ${r.paired.tasks} tasks: both ${r.paired.both_solved}, neither ${r.paired.neither_solved}, only ${r.paired.candidate} ${r.paired.candidate_only.length} (${r.paired.candidate_only.join(", ") || "—"}), only omp-stock ${r.paired.baseline_only.length} (${r.paired.baseline_only.join(", ") || "—"}). Exact two-sided sign test p = ${r.paired.sign_test.p_two_sided.toPrecision(3)}.`
      : `Not available: ${r.verdict.confirmatory_arm} did not run.`,
    "",
    ...(r.secondary
      ? [
          `## Secondary comparisons: ${r.secondary.label}`,
          "",
          `Best measured MARS arm: ${r.secondary.best_arm ?? "none"} (descriptive; it does not decide the bar). Holm-adjusted p-values cover all ${r.secondary.comparisons.length} MARS-vs-omp-stock comparisons.`,
          "",
          "| Arm | Only this arm | Only omp-stock | p (raw) | p (Holm) |",
          "| --- | --- | --- | --- | --- |",
          ...r.secondary.comparisons.map(
            (c) =>
              `| ${c.arm}${c.confirmatory ? " (confirmatory)" : ""} | ${c.paired.candidate_only.length} | ${c.paired.baseline_only.length} | ${c.p_raw.toPrecision(3)} | ${c.p_holm.toPrecision(3)} |`,
          ),
          "",
        ]
      : []),
    "## Pre-registered bar",
    "",
    `${PREREGISTERED_BAR.statement}`,
    "",
    `**${r.verdict.exploratory ? "EXPLORATORY (no verdict)" : r.verdict.met ? "MET" : "NOT MET"}** — ${r.verdict.summary}`,
    "",
    "## Limitations",
    "",
    ...r.limitations.map((item) => `- ${item}`),
    "",
  ];
  return lines.join("\n");
}
