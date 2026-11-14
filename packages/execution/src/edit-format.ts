import type { ModelConfig } from "@mars/contracts";

/**
 * Every MARS edit format has a benchmark driver and can be chosen by
 * evidence. Order is the benchmark's default arm order.
 */
export const MARS_EDIT_FORMATS = [
  "hashline",
  "replace",
  "apply_patch",
] as const;
export type MarsEditFormat = (typeof MARS_EDIT_FORMATS)[number];

/**
 * The static default when no benchmark evidence exists and the model is
 * unknown; with a model, `defaultEditFormat` (omp's per-model rule) applies.
 */
export const DEFAULT_MARS_EDIT_FORMAT: MarsEditFormat = "hashline";

export function isMarsEditFormat(value: unknown): value is MarsEditFormat {
  return (
    typeof value === "string" &&
    (MARS_EDIT_FORMATS as readonly string[]).includes(value)
  );
}

export const EDIT_FORMAT_EVIDENCE_SCHEMA = "mars.edit-format-evidence/v1";
export const EDIT_FORMAT_DECISION_SCHEMA = "mars.edit-format-decision/v1";

/** One MARS arm of a verified benchmark report, reduced to what selection needs. */
export interface EditFormatArmEvidence {
  format: string;
  trials: number;
  verified_solves: number;
  solve_rate: number;
  cost_per_verified_solve_usd: number | null;
  tokens_per_verified_solve: number | null;
}

/**
 * Produced by `@mars/evaluation` from a report whose digest (and signature,
 * when a trust key is configured) has already been verified.
 */
export interface EditFormatEvidence {
  schema: typeof EDIT_FORMAT_EVIDENCE_SCHEMA;
  report_sha256: string;
  model_id: string;
  repository: string;
  generated_at: string;
  simulated: boolean;
  arms: EditFormatArmEvidence[];
}

export interface EditFormatDecision {
  schema: typeof EDIT_FORMAT_DECISION_SCHEMA;
  model_id: string;
  repository: string;
  format: MarsEditFormat;
  source: "benchmark" | "static_default";
  reason:
    | "best_verified_solve_rate"
    | "no_report_for_model"
    | "simulated_report_refused"
    | "no_available_format_solved";
  report_sha256: string | null;
  candidates: Array<{
    format: string;
    solve_rate: number;
    trials: number;
    cost_per_verified_solve_usd: number | null;
    tokens_per_verified_solve: number | null;
    available: boolean;
  }>;
}

const lowerCost = (a: EditFormatArmEvidence, b: EditFormatArmEvidence) => {
  const usd = compareNullable(
    a.cost_per_verified_solve_usd,
    b.cost_per_verified_solve_usd,
  );
  if (usd !== 0) return usd;
  return compareNullable(
    a.tokens_per_verified_solve,
    b.tokens_per_verified_solve,
  );
};

function compareNullable(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

/**
 * Picks the edit format for `modelId` on `repository`: the newest report for
 * that pair decides by verified solve rate (ties: lower cost per verified
 * solve in USD, then tokens, then the order of `available`). Without such a
 * report, or when no available format solved anything, the static default
 * is used. Simulated (fake-model) reports never decide unless allowed.
 */
export function selectEditFormat(input: {
  modelId: string;
  repository: string;
  evidence: readonly EditFormatEvidence[];
  available?: readonly MarsEditFormat[];
  staticDefault?: MarsEditFormat;
  /** The selected model, for the per-model static default. */
  model?: Pick<ModelConfig, "id" | "model">;
  allowSimulated?: boolean;
}): EditFormatDecision {
  const available = input.available ?? MARS_EDIT_FORMATS;
  const fallback =
    input.staticDefault ??
    (input.model ? defaultEditFormat(input.model) : DEFAULT_MARS_EDIT_FORMAT);
  const base = {
    schema: EDIT_FORMAT_DECISION_SCHEMA,
    model_id: input.modelId,
    repository: input.repository,
  } as const;
  const matching = input.evidence
    .filter(
      (item) =>
        item.schema === EDIT_FORMAT_EVIDENCE_SCHEMA &&
        item.model_id === input.modelId &&
        item.repository === input.repository,
    )
    .sort((a, b) =>
      a.generated_at === b.generated_at
        ? a.report_sha256 < b.report_sha256
          ? 1
          : -1
        : a.generated_at < b.generated_at
          ? 1
          : -1,
    );
  const real = matching.filter(
    (item) => input.allowSimulated === true || !item.simulated,
  );
  const report = real[0];
  if (!report)
    return {
      ...base,
      format: fallback,
      source: "static_default",
      reason:
        matching.length > 0
          ? "simulated_report_refused"
          : "no_report_for_model",
      report_sha256: null,
      candidates: [],
    };
  const candidates = report.arms.map((arm) => ({
    format: arm.format,
    solve_rate: arm.solve_rate,
    trials: arm.trials,
    cost_per_verified_solve_usd: arm.cost_per_verified_solve_usd,
    tokens_per_verified_solve: arm.tokens_per_verified_solve,
    available: (available as readonly string[]).includes(arm.format),
  }));
  const ranked = report.arms
    .filter(
      (arm) =>
        arm.trials > 0 &&
        arm.verified_solves > 0 &&
        (available as readonly string[]).includes(arm.format),
    )
    .sort(
      (a, b) =>
        b.solve_rate - a.solve_rate ||
        lowerCost(a, b) ||
        available.indexOf(a.format as MarsEditFormat) -
          available.indexOf(b.format as MarsEditFormat),
    );
  const best = ranked[0];
  if (!best || !isMarsEditFormat(best.format))
    return {
      ...base,
      format: fallback,
      source: "static_default",
      reason: "no_available_format_solved",
      report_sha256: report.report_sha256,
      candidates,
    };
  return {
    ...base,
    format: best.format,
    source: "benchmark",
    reason: "best_verified_solve_rate",
    report_sha256: report.report_sha256,
    candidates,
  };
}
export type EditFormat = "hashline" | "replace" | "apply_patch";

// omp 18.14.0 edit-mode defaults (MIT): pi-coding-agent/src/utils/edit-mode.ts
// lines 22-44, src/edit/settings.ts:40, CHANGELOG.md:143. Minimal matching from
// pi-catalog/src/identity/index.ts:2 -> compat/taxonomy.ts:55-81, 456 onward;
// class tokens/families come from compat/rules/taxonomy/{kimi,mimo,minimax,
// deepseek,stepfun,openai,glm,qwen}.kdl.
// no pi-catalog runtime dependency or ambient omp settings/environment overrides.
export function defaultEditFormat(
  model: Pick<ModelConfig, "id" | "model">,
): EditFormat {
  return [model.id, model.model].some((name) => {
    const lower = name.toLowerCase();
    if (lower.includes("distill-qwen")) return false;
    return (
      /(?:^|[/.:\s_-])(?:kimi|mimo|minimax|deepseek|stepfun)(?=$|[/.:\s_\d-])/.test(
        lower,
      ) ||
      /(?:^|[/.:\s])(?:step|hailuo)(?=$|[-_.:\d])/.test(lower) ||
      /(?:^|\/)moonshotai\//.test(lower) ||
      /(?:^|\/)k3(?:-256k|\.1-pro(?:-highspeed)?)?$/.test(lower) ||
      /codex[-_]spark/.test(lower) ||
      /(?:^|[/.:\s])glm[-_ ]?5\.3(?:\.0)?(?:[-_ ]|$).*flash/.test(lower) ||
      /(?:^|[/.:\s])qwen[-_ ]?3\.8(?:\.0)?(?=$|[-_: /])/.test(lower)
    );
  })
    ? "replace"
    : "hashline";
}

export function resolveEditFormat(
  model: Pick<ModelConfig, "id" | "model" | "editFormat">,
  options: { patchAvailable: boolean },
): { format: EditFormat; requested: EditFormat; source: "config" | "default" } {
  const requested = model.editFormat ?? defaultEditFormat(model);
  return {
    format:
      requested === "apply_patch" && !options.patchAvailable
        ? "hashline"
        : requested,
    requested,
    source: model.editFormat === undefined ? "default" : "config",
  };
}
