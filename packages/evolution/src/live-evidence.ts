import { bounded, scrubSecrets } from "./util";

/**
 * Static scope of `live.acceptance.test.ts`: it pairs real Harbor evaluation
 * with a scripted proposer and host-process builds, so no run of it is evidence
 * of model-driven proposing or Docker-isolated builds. What a particular run
 * established is computed from what it observed by `liveEvidenceRecord`.
 */
export const LIVE_ACCEPTANCE_EVIDENCE = Object.freeze({
  schema: "mars.evolution-live-evidence/v1",
  scope: "partial",
  proposer: "scripted",
  build_isolation: "host-process",
  evaluation: "harbor",
  does_not_establish: Object.freeze([
    "model-driven proposing (the proposer is createScriptedProposer)",
    "Docker-isolated builds (the sandbox is createProcessSandbox, not an OS boundary)",
    "tool, skill or retrieval mutations (Harbor applies only system_prompt)",
    "a matched-budget comparison against upstream DGM",
  ]),
});

export interface LiveRunObservation {
  readonly status: "passed" | "failed";
  readonly verdict?: "accepted" | "no_improvement" | "rejected" | undefined;
  readonly rolled_back: boolean;
  readonly verified_after_reopen: boolean;
  readonly error?: string;
}

export interface LiveEvidenceRecord {
  readonly schema: string;
  readonly scope: string;
  readonly proposer: string;
  readonly build_isolation: string;
  readonly evaluation: string;
  readonly status: "passed" | "failed";
  readonly verdict: string | null;
  readonly error: string | null;
  readonly establishes: readonly string[];
  readonly does_not_establish: readonly string[];
}

/** Evidence for one finished live run: only what it observed, and only if it passed. */
export function liveEvidenceRecord(
  observed: LiveRunObservation,
): LiveEvidenceRecord {
  const passed = observed.status === "passed";
  const establishes: string[] = [];
  if (passed) {
    establishes.push(
      "Harbor/mini-swe-agent evaluation of a system_prompt mutation against the baseline",
    );
    if (observed.verdict)
      establishes.push(`final-holdout promotion verdict: ${observed.verdict}`);
    if (observed.rolled_back)
      establishes.push("rollback to the previous champion");
    if (observed.verified_after_reopen)
      establishes.push(
        "lineage verification and champion pointer surviving reopen",
      );
  }
  const gaps = [...LIVE_ACCEPTANCE_EVIDENCE.does_not_establish];
  if (!passed) gaps.unshift("anything: the live run failed");
  else if (!observed.rolled_back)
    gaps.push("rollback (exercised only when the verdict is accepted)");
  return {
    schema: LIVE_ACCEPTANCE_EVIDENCE.schema,
    scope: LIVE_ACCEPTANCE_EVIDENCE.scope,
    proposer: LIVE_ACCEPTANCE_EVIDENCE.proposer,
    build_isolation: LIVE_ACCEPTANCE_EVIDENCE.build_isolation,
    evaluation: LIVE_ACCEPTANCE_EVIDENCE.evaluation,
    status: observed.status,
    verdict: observed.verdict ?? null,
    error:
      observed.error === undefined
        ? null
        : bounded(scrubSecrets(observed.error), 2_000),
    establishes,
    does_not_establish: gaps,
  };
}
