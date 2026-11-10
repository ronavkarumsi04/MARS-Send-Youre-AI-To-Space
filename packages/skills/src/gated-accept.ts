import { gateRequired, meetsGatePolicy, type SkillGateResult } from "./gate";
import type { SkillOutcomeLedger } from "./outcomes";
import { type MutationOptions, SkillError, type SkillStore } from "./store";

export interface GatedAcceptResult {
  revision: string;
  /** The passing verdict acceptance relied on; null when none was required or it was overridden. */
  gate: SkillGateResult | null;
  /** True when an operator accepted without a passing verdict (recorded in the ledger). */
  overridden: boolean;
}

/**
 * Accepts a proposal only when it carries measured evidence: proposals that
 * write skill instructions need a passing gate verdict that meets
 * `GATE_POLICY`, unless an operator explicitly overrides with a reason, which
 * is recorded before the skill store changes.
 */
export async function acceptWithGate(
  store: SkillStore,
  ledger: SkillOutcomeLedger,
  id: string,
  options: MutationOptions,
  override?: { reason: string },
): Promise<GatedAcceptResult> {
  const proposal = (await store.listProposals()).find((p) => p.id === id);
  if (!proposal || proposal.status !== "pending")
    throw new SkillError("not-pending", "Proposal is not pending");
  if (!gateRequired(proposal.ops))
    return {
      revision: await store.accept(id, options),
      gate: null,
      overridden: false,
    };
  const gate = ledger.gates(id).findLast((g) => meetsGatePolicy(g)) ?? null;
  if (!gate) {
    if (!override)
      throw new SkillError(
        "gate-required",
        "No passing gate verdict for this proposal; run the held-out gate or accept without it with a reason",
      );
    const reason = override.reason.trim();
    if (!reason)
      throw new SkillError(
        "invalid",
        "A reason is required to accept without a passing gate verdict",
      );
    ledger.recordGateOverride({
      proposal_id: id,
      actor: options.actor,
      reason,
      recorded_at: Date.now(),
    });
  }
  return {
    revision: await store.accept(id, options),
    gate,
    overridden: !gate,
  };
}

/** One-line gate state of a proposal, for operators deciding whether to accept it. */
export function describeGate(
  proposal: { id: string; ops: readonly { op: string }[] },
  ledger: SkillOutcomeLedger,
): string {
  if (!gateRequired(proposal.ops)) return "not required";
  const verdicts = ledger.gates(proposal.id);
  const passing = verdicts.findLast((g) => meetsGatePolicy(g));
  if (passing) return `passed (${passing.digest.slice(0, 12)})`;
  const overrides = ledger.gateOverrides(proposal.id);
  const override = overrides.at(-1);
  if (override)
    return `accepted without gate by ${override.actor}: ${override.reason}`;
  const last = verdicts.at(-1);
  if (last)
    return last.passed
      ? `passed with thresholds looser than the policy (${last.digest.slice(0, 12)})`
      : `failed: ${last.reasons.join(", ")}`;
  return "none yet";
}
