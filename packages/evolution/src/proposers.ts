import type { AgentManifest, MutationProposal } from "./schemas";
import type { SelfImproveEntry } from "./selection";

/** What a proposer sees. Selection-split feedback only; the final test set is never included. */
export interface ProposalContext {
  run_id: string;
  generation: number;
  child_index: number;
  parent: {
    candidate_id: string;
    manifest: AgentManifest;
    selection_score: number;
    per_task: { task_id: string; mean: number }[];
  };
  entry: SelfImproveEntry;
  /** Scratch copy of the parent's harness tree. Edits here are ignored; only the returned patch counts. */
  harness_dir: string;
  seed: string;
}

/**
 * Produces one mutation. Its output is untrusted: the host validates the
 * schema, refuses protected/out-of-allowlist paths, applies the patch in a
 * fresh workspace and re-digests control state before anything is evaluated.
 */
export interface MutationProposer {
  readonly id: string;
  propose(
    context: ProposalContext,
    signal: AbortSignal,
  ): Promise<MutationProposal>;
}

/** Deterministic proposer for tests and replay (no model). */
export function createScriptedProposer(
  id: string,
  script: (
    context: ProposalContext,
  ) => MutationProposal | Promise<MutationProposal>,
): MutationProposer {
  return {
    id,
    async propose(context) {
      return script(context);
    },
  };
}
