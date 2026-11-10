import type { RequestContext } from "@mars/contracts";
import {
  acceptWithGate,
  describeGate,
  gateRequired,
  helpfulness,
  isQuarantined,
  meetsGatePolicy,
  type Proposal,
  reviewIdFromSource,
  SkillError,
  type SkillGateResult,
  type SkillOutcomeLedger,
  type SkillStore,
} from "@mars/skills";
import type {
  SkillProposalAcceptParams,
  SkillProposalListParams,
  SkillProposalRejectParams,
  SkillProposalView,
  SkillReviewUndoParams,
  SkillReviewUndoResult,
  SkillView,
} from "./protocol";
import { WorkbenchError } from "./server";

/** Operator surface over the host's skill store and outcome ledger (the same files `mars skills` uses). */
export interface WorkbenchSkillOperator {
  store: SkillStore;
  ledger: SkillOutcomeLedger;
}

const finiteOrNull = (value: number) => (Number.isFinite(value) ? value : null);

function gateView(result: SkillGateResult) {
  const p = finiteOrNull(result.p_value);
  return {
    passed: result.passed,
    meets_policy: meetsGatePolicy(result),
    reasons: result.reasons,
    trials: result.trials,
    wins: result.wins,
    losses: result.losses,
    ties: result.ties,
    p_value: p === null ? null : Math.min(1, Math.max(0, p)),
    cost_ratio: finiteOrNull(result.cost_ratio),
    digest: result.digest,
  };
}

function proposalView(
  proposal: Proposal,
  ledger: SkillOutcomeLedger,
): SkillProposalView {
  const verdicts = ledger.gates(proposal.id);
  const latest = verdicts.at(-1);
  const required = gateRequired(proposal.ops);
  return {
    proposal_id: proposal.id,
    source: proposal.source,
    review_id: reviewIdFromSource(proposal.source) ?? null,
    rationale: proposal.rationale,
    status: proposal.status,
    ...(proposal.reason === undefined ? {} : { reason: proposal.reason }),
    operations: proposal.ops.map((op) => ({
      op: op.op,
      name: op.name,
      ...("content" in op ? { content: op.content } : {}),
      ...("pinned" in op ? { pinned: op.pinned } : {}),
      ...("versionId" in op ? { version_id: op.versionId } : {}),
    })),
    gate: {
      required,
      cleared: !required || verdicts.some((v) => meetsGatePolicy(v)),
      summary: describeGate(proposal, ledger),
      latest: latest ? gateView(latest) : null,
    },
  };
}

function translate(error: unknown): never {
  if (!(error instanceof SkillError)) throw error;
  switch (error.code) {
    case "not-found":
      throw new WorkbenchError("not_found");
    case "invalid":
    case "invalid-content":
    case "empty":
    case "frontmatter":
    case "threat":
    case "unsafe-path":
      throw new WorkbenchError("invalid_request");
    case "corrupt":
    case "invalid-state":
      throw new WorkbenchError("internal_error");
    default:
      // not-pending, stale-revision, gate-required, pinned, conflict, ...
      throw new WorkbenchError("conflict");
  }
}

export function skillOperatorApi(
  operator: () => WorkbenchSkillOperator,
  mutation: (
    context: RequestContext,
    actor?: string,
  ) => { actor: string; source: string },
) {
  const find = async (id: string) => {
    const { store, ledger } = operator();
    const proposal = (await store.listProposals()).find((p) => p.id === id);
    if (!proposal) throw new WorkbenchError("not_found");
    return proposalView(proposal, ledger);
  };
  return {
    async skills(_context: RequestContext): Promise<SkillView[]> {
      const { store, ledger } = operator();
      const stats = ledger.stats();
      return (await store.list())
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((skill) => {
          const s = stats.get(skill.name);
          return {
            name: skill.name,
            status: skill.status,
            pinned: skill.pinned,
            content: skill.content,
            use_count: skill.useCount,
            last_activity: skill.lastActivity,
            outcomes: s
              ? {
                  loads: s.loads,
                  verified: s.verified,
                  baseline_rate: Math.min(1, Math.max(0, s.baseline_rate)),
                  baseline_loads: s.baseline_loads,
                  helpfulness: helpfulness(s),
                  quarantined: isQuarantined(s),
                }
              : null,
          };
        });
    },
    async skillProposals(
      _context: RequestContext,
      params: SkillProposalListParams,
    ): Promise<SkillProposalView[]> {
      const { store, ledger } = operator();
      return (await store.listProposals())
        .filter(
          (p) => params.status === undefined || p.status === params.status,
        )
        .map((p) => proposalView(p, ledger));
    },
    async acceptSkillProposal(
      context: RequestContext,
      params: SkillProposalAcceptParams,
    ): Promise<SkillProposalView> {
      const { store, ledger } = operator();
      await acceptWithGate(
        store,
        ledger,
        params.proposal_id,
        mutation(context, params.resolved_by),
        params.without_gate_reason === undefined
          ? undefined
          : { reason: params.without_gate_reason },
      ).catch(translate);
      return find(params.proposal_id);
    },
    async rejectSkillProposal(
      context: RequestContext,
      params: SkillProposalRejectParams,
    ): Promise<SkillProposalView> {
      const { store } = operator();
      await store
        .reject(
          params.proposal_id,
          params.reason,
          mutation(context, params.resolved_by),
        )
        .catch(translate);
      return find(params.proposal_id);
    },
    async undoSkillReview(
      context: RequestContext,
      params: SkillReviewUndoParams,
    ): Promise<SkillReviewUndoResult> {
      const { store } = operator();
      const changes = await store
        .undoReview(params.review_id, mutation(context, params.resolved_by))
        .catch(translate);
      return { undone: changes.length };
    },
  };
}
