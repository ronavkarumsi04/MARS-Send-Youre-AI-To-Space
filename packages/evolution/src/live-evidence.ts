/**
 * What a passing `live.acceptance.test.ts` run does and does not establish.
 * The opt-in live test pairs real Harbor evaluation with a scripted proposer
 * and host-process builds, so its evidence must not be read as model-driven
 * proposing or Docker-isolated builds.
 */
export const LIVE_ACCEPTANCE_EVIDENCE = Object.freeze({
  schema: "mars.evolution-live-evidence/v1",
  scope: "partial",
  proposer: "scripted",
  build_isolation: "host-process",
  evaluation: "harbor",
  establishes: Object.freeze([
    "Harbor/mini-swe-agent evaluation of a system_prompt mutation against the baseline",
    "final-holdout promotion verdict (accepted, no_improvement or rejected)",
    "rollback and lineage verification surviving reopen",
  ]),
  does_not_establish: Object.freeze([
    "model-driven proposing (the proposer is createScriptedProposer)",
    "Docker-isolated builds (the sandbox is createProcessSandbox, not an OS boundary)",
    "tool, skill or retrieval mutations (Harbor applies only system_prompt)",
    "a matched-budget comparison against upstream DGM",
  ]),
});

export type LiveAcceptanceEvidence = typeof LIVE_ACCEPTANCE_EVIDENCE;
