import type { SkillSource } from "./conventions-types";
import {
  evaluateSkillGate,
  GATE_POLICY,
  GateTrialsSchema,
  type SkillGateOptions,
  type SkillGateReason,
  signTestPValue,
} from "./gate";
import type { SkillOutcomeRow, SkillTrialRow } from "./outcomes";
import { wilsonInterval } from "./selection";

export interface SkillProvenance {
  origin: "store" | SkillSource;
  path?: string;
  lock?: unknown;
}

export interface SkillEvidenceInput {
  outcomes: readonly SkillOutcomeRow[];
  trials: readonly SkillTrialRow[];
  provenance?: readonly {
    scope_key?: string;
    skill: string;
    provenance: SkillProvenance;
  }[];
  policy?: Readonly<Required<SkillGateOptions>>;
}

function observational(rows: readonly SkillOutcomeRow[]) {
  const verified = rows.filter((row) => row.verified).length;
  const cost = rows.some((row) => row.cost_usd == null)
    ? null
    : rows.reduce((sum, row) => sum + (row.cost_usd ?? 0), 0);
  return {
    tasks: rows.length,
    verified,
    rate: rows.length ? verified / rows.length : null,
    interval: wilsonInterval(verified, rows.length),
    cost_usd: cost,
    cost_per_verified_solve: cost !== null && verified ? cost / verified : null,
  };
}

/** Observational splits are not matched controls; only held-out pairs decide verdicts. */
export function skillEvidenceReport({
  outcomes,
  trials,
  provenance = [],
  policy = GATE_POLICY,
}: SkillEvidenceInput) {
  const scopes = new Map<string, Set<string>>();
  const rowsByScope = new Map<string, SkillOutcomeRow[]>();
  const add = (scope: string, skill: string) => {
    const names = scopes.get(scope) ?? new Set<string>();
    names.add(skill);
    scopes.set(scope, names);
  };
  for (const row of outcomes) {
    const rows = rowsByScope.get(row.scope_key) ?? [];
    rows.push(row);
    rowsByScope.set(row.scope_key, rows);
    for (const skill of row.skills) add(row.scope_key, skill.name);
  }
  for (const row of trials) add(row.scope_key, row.skill);
  return [...scopes.keys()].sort().flatMap((scope_key) =>
    [...(scopes.get(scope_key) ?? [])].sort().map((skill) => {
      const rows = rowsByScope.get(scope_key) ?? [];
      const loaded = (row: SkillOutcomeRow) =>
        row.skills.some((item) => item.name === skill);
      const withSkill = observational(rows.filter(loaded));
      const without = observational(rows.filter((row) => !loaded(row)));
      const pairs = trials
        .filter((row) => row.scope_key === scope_key && row.skill === skill)
        .map(({ task_id, baseline, candidate }) => ({
          task_id,
          baseline,
          candidate,
        }));
      const gate = evaluateSkillGate(
        { proposal_id: skill, evidence_task_ids: [], trials: pairs },
        policy,
      );
      const reasons: SkillGateReason[] = gate.reasons.filter(
        (reason) =>
          reason !== "evidence-missing" && reason !== "evidence-overlap",
      );
      if (
        !GateTrialsSchema.safeParse(pairs).success &&
        !reasons.includes("invalid-trial")
      )
        reasons.push("invalid-trial");
      const pHurts = signTestPValue(gate.losses, gate.wins);
      let verdict: "helps" | "no_evidence" | "hurts" = "no_evidence";
      if (
        pairs.length >= policy.min_trials &&
        !reasons.includes("invalid-trial") &&
        !reasons.includes("duplicate-trial")
      ) {
        if (!reasons.length) verdict = "helps";
        else if (
          pHurts <= policy.alpha ||
          (gate.cost_ratio > policy.max_cost_ratio &&
            gate.p_value > policy.alpha)
        )
          verdict = "hurts";
      }
      const costPerSolve = (side: "baseline" | "candidate") => {
        const passed = pairs.filter((pair) => pair[side].verified).length;
        const cost = pairs.reduce((sum, pair) => sum + pair[side].cost_usd, 0);
        return passed && Number.isFinite(cost) && cost >= 0
          ? cost / passed
          : null;
      };
      return {
        scope_key,
        skill,
        versions: [
          ...new Set(
            rows.flatMap((row) =>
              row.skills
                .filter((item) => item.name === skill)
                .map((item) => item.sha256),
            ),
          ),
        ].sort(),
        provenance:
          provenance.find(
            (item) => item.scope_key === scope_key && item.skill === skill,
          )?.provenance ??
          provenance.find(
            (item) => item.scope_key === undefined && item.skill === skill,
          )?.provenance ??
          null,
        with: withSkill,
        without,
        difference:
          withSkill.rate !== null && without.rate !== null
            ? withSkill.rate - without.rate
            : null,
        held_out: {
          trials: gate.trials,
          wins: gate.wins,
          losses: gate.losses,
          ties: gate.ties,
          discordant: gate.wins + gate.losses,
          baseline_rate: pairs.length ? gate.baseline_rate : null,
          candidate_rate: pairs.length ? gate.candidate_rate : null,
          p_value: gate.p_value,
          p_value_hurts: pHurts,
          cost_ratio: Number.isFinite(gate.cost_ratio) ? gate.cost_ratio : null,
          cost_ratio_infinite: gate.cost_ratio === Number.POSITIVE_INFINITY,
          baseline_cost_per_verified_solve: costPerSolve("baseline"),
          candidate_cost_per_verified_solve: costPerSolve("candidate"),
          reasons: reasons.sort(),
        },
        verdict,
        policy: { ...policy },
      };
    }),
  );
}

export type SkillEvidenceEntry = ReturnType<typeof skillEvidenceReport>[number];
