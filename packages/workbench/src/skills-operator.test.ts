import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestContext } from "@mars/contracts";
import {
  evaluateSkillGate,
  SkillOutcomeLedger,
  SkillStore,
} from "@mars/skills";
import { SkillProposalViewSchema, SkillViewSchema } from "./protocol";
import { WorkbenchError } from "./server";
import { skillOperatorApi } from "./skills-operator";

const context = {
  schema_version: 1,
  scope: { owner_id: "alice", project_id: "p" },
  request_id: "r",
} as RequestContext;
const content = (name: string) =>
  `---\nname: ${name}\ndescription: How to ${name}.\n---\nDo it.\n`;
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error) => (error instanceof WorkbenchError ? error.code : String(error)),
  );

test("skill operator API gates acceptance, records overrides and undoes reviews", async () => {
  const dir = mkdtempSync(join(tmpdir(), "skills-operator-"));
  const store = new SkillStore(join(dir, "skills"));
  const ledger = new SkillOutcomeLedger(join(dir, "outcomes.sqlite"));
  try {
    const api = skillOperatorApi(
      () => ({ store, ledger }),
      (ctx, actor) => ({
        actor: actor ?? ctx.scope.owner_id,
        source: "operator",
      }),
    );
    const propose = (name: string, review: string) =>
      store.submitProposal({
        source: `background_review:s:${review}`,
        rationale: name,
        ops: [{ op: "create", name, content: content(name) }],
      });
    const gated = await propose("gated", "r1");
    const forced = await propose("forced", "r2");

    const [listed] = await api.skillProposals(context, { status: "pending" });
    expect(SkillProposalViewSchema.parse(listed)).toMatchObject({
      review_id: "r1",
      gate: {
        required: true,
        cleared: false,
        summary: "none yet",
        latest: null,
      },
    });
    expect(
      await code(api.acceptSkillProposal(context, { proposal_id: gated.id })),
    ).toBe("conflict");

    ledger.recordGate(
      evaluateSkillGate({
        proposal_id: gated.id,
        evidence_task_ids: ["learned"],
        trials: Array.from({ length: 10 }, (_, i) => ({
          task_id: `held-${i}`,
          baseline: { verified: false, cost_usd: 0 },
          candidate: { verified: true, cost_usd: 0 },
        })),
      }),
    );
    const accepted = await api.acceptSkillProposal(context, {
      proposal_id: gated.id,
    });
    expect(accepted.status).toBe("accepted");
    expect(accepted.gate.cleared).toBe(true);
    expect(accepted.gate.latest).toMatchObject({
      passed: true,
      meets_policy: true,
      trials: 10,
      cost_ratio: 1,
    });

    // A free baseline makes the cost ratio infinite, which JSON carries as null.
    ledger.recordGate(
      evaluateSkillGate({
        proposal_id: forced.id,
        evidence_task_ids: ["learned"],
        trials: [
          {
            task_id: "held",
            baseline: { verified: true, cost_usd: 0 },
            candidate: { verified: true, cost_usd: 1 },
          },
        ],
      }),
    );
    const [failing] = await api.skillProposals(context, {
      status: "pending",
    });
    expect(failing?.gate.latest?.cost_ratio).toBeNull();
    expect(failing?.gate.summary).toStartWith("failed: ");

    const overridden = await api.acceptSkillProposal(context, {
      proposal_id: forced.id,
      without_gate_reason: "no model key yet",
    });
    expect(overridden.gate.summary).toBe(
      "accepted without gate by alice: no model key yet",
    );
    expect(ledger.gateOverrides(forced.id)).toHaveLength(1);

    const skills = await api.skills(context);
    expect(skills.map((s) => SkillViewSchema.parse(s).name)).toEqual([
      "forced",
      "gated",
    ]);
    expect(skills[0]?.outcomes).toBeNull();

    const archive = await store.submitProposal({
      source: "operator",
      rationale: "noise",
      ops: [{ op: "archive", name: "forced" }],
    });
    const rejected = await api.rejectSkillProposal(context, {
      proposal_id: archive.id,
      reason: "keep it",
    });
    expect(rejected).toMatchObject({ status: "rejected", reason: "keep it" });
    expect(
      await code(
        api.rejectSkillProposal(context, {
          proposal_id: archive.id,
          reason: "x",
        }),
      ),
    ).toBe("conflict");
    expect(
      await code(api.acceptSkillProposal(context, { proposal_id: "nope" })),
    ).toBe("conflict");

    expect(await api.undoSkillReview(context, { review_id: "r1" })).toEqual({
      undone: 1,
    });
    expect((await store.get("gated"))?.status).toBe("archived");
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
