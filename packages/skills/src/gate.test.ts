import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateSkillGate,
  GATE_POLICY,
  type GateTrial,
  gateRequired,
  harmfulSkillArchivals,
  meetsGatePolicy,
  signTestPValue,
} from "./gate";
import { acceptWithGate, describeGate } from "./gated-accept";
import { SkillOutcomeLedger } from "./outcomes";
import { SkillStore } from "./store";

const trial = (
  id: string,
  baseline: boolean,
  candidate: boolean,
  cost = 1,
): GateTrial => ({
  task_id: id,
  baseline: { verified: baseline, cost_usd: 1 },
  candidate: { verified: candidate, cost_usd: cost },
});
const winning = [
  ...Array.from({ length: 6 }, (_, i) => trial(`win-${i}`, false, true)),
  ...Array.from({ length: 4 }, (_, i) => trial(`tie-${i}`, true, true)),
];

test("the exact sign test matches the binomial tail", () => {
  expect(signTestPValue(6, 0)).toBeCloseTo(1 / 64, 10);
  expect(signTestPValue(0, 0)).toBe(1);
  expect(signTestPValue(5, 1)).toBeCloseTo(7 / 64, 10);
});

test("a skill passes only on held-out, significant, regression-free and affordable evidence", () => {
  const passed = evaluateSkillGate({
    proposal_id: "p",
    evidence_task_ids: ["learned-1"],
    trials: winning,
  });
  expect(passed).toMatchObject({
    passed: true,
    reasons: [],
    wins: 6,
    losses: 0,
    ties: 4,
    baseline_rate: 0.4,
    candidate_rate: 1,
  });
  const regression = evaluateSkillGate({
    proposal_id: "p",
    evidence_task_ids: ["learned-1"],
    trials: [...winning, trial("lost", true, false)],
  });
  expect(regression.reasons).toEqual(["not-significant", "regression"]);
  expect(
    evaluateSkillGate({
      proposal_id: "p",
      evidence_task_ids: ["win-0"],
      trials: winning,
    }).reasons,
  ).toEqual(["evidence-overlap"]);
  expect(
    evaluateSkillGate({ proposal_id: "p", evidence_task_ids: [], trials: [] })
      .reasons,
  ).toEqual(["evidence-missing", "not-significant", "too-few-trials"]);
  expect(
    evaluateSkillGate({
      proposal_id: "p",
      evidence_task_ids: ["learned-1"],
      trials: winning.map((t) => ({
        ...t,
        candidate: { ...t.candidate, cost_usd: 2 },
      })),
    }).reasons,
  ).toEqual(["cost"]);
  expect(
    evaluateSkillGate({
      proposal_id: "p",
      evidence_task_ids: ["learned-1"],
      trials: [...winning, winning[0] as GateTrial],
    }).reasons,
  ).toContain("duplicate-trial");
  expect(
    evaluateSkillGate({
      proposal_id: "p",
      evidence_task_ids: ["learned-1"],
      trials: [...winning, trial("nan", false, true, Number.NaN)],
    }).reasons,
  ).toContain("invalid-trial");
});

test("gate verdicts are reproducible and stored once per input digest", () => {
  const input = {
    proposal_id: "p",
    evidence_task_ids: ["learned-1"],
    trials: winning,
  };
  const first = evaluateSkillGate(input);
  const reordered = evaluateSkillGate({
    ...input,
    trials: [...winning].reverse(),
  });
  expect(reordered.digest).toBe(first.digest);
  expect(evaluateSkillGate(input, { alpha: 0.01 }).digest).not.toBe(
    first.digest,
  );
  const dir = mkdtempSync(join(tmpdir(), "mars-skill-gates-"));
  try {
    const ledger = new SkillOutcomeLedger(join(dir, "outcomes.sqlite"));
    ledger.recordGate(first, 1);
    ledger.recordGate(reordered, 2);
    expect(ledger.gates("p")).toEqual([first]);
    expect(ledger.gates("other")).toEqual([]);
    ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("harmful skills get archive proposals, never pinned or archived ones", () => {
  const harmful = {
    loads: 10,
    verified: 1,
    baseline_loads: 20,
    baseline_rate: 0.9,
  };
  const stats = new Map(
    ["hurts", "pinned", "gone", "fine"].map((name) => [
      name,
      name === "fine"
        ? {
            name,
            loads: 10,
            verified: 9,
            baseline_loads: 20,
            baseline_rate: 0.9,
          }
        : { name, ...harmful },
    ]),
  );
  const proposals = harmfulSkillArchivals(
    [
      { name: "hurts", status: "active" },
      { name: "pinned", status: "active", pinned: true },
      { name: "gone", status: "archived" },
      { name: "fine", status: "active" },
    ],
    stats,
  );
  expect(proposals).toEqual([
    {
      source: "outcome_gate",
      rationale:
        "Verified outcomes: 1/10 tasks passed with hurts vs 90.0% of 20 without it.",
      ops: [{ op: "archive", name: "hurts" }],
    },
  ]);
});

test("blank evidence ids do not count as cited runs", () => {
  expect(
    evaluateSkillGate({
      proposal_id: "p",
      evidence_task_ids: ["", "  "],
      trials: winning,
    }).reasons,
  ).toEqual(["evidence-missing"]);
});

test("the sign test stays finite for large trial counts", () => {
  const p = signTestPValue(400, 624);
  expect(Number.isFinite(p)).toBe(true);
  expect(p).toBeGreaterThan(0.99);
  expect(signTestPValue(1_024, 0)).toBeLessThan(1e-300);
  const losing = evaluateSkillGate(
    {
      proposal_id: "p",
      evidence_task_ids: ["learned-1"],
      trials: [
        ...Array.from({ length: 400 }, (_, i) => trial(`w-${i}`, false, true)),
        ...Array.from({ length: 624 }, (_, i) => trial(`l-${i}`, true, false)),
      ],
    },
    { max_regressions: 1_000 },
  );
  expect(losing.passed).toBe(false);
  expect(losing.reasons).toContain("not-significant");
});

test("an infinite cost ratio survives storage", () => {
  const free = evaluateSkillGate({
    proposal_id: "free",
    evidence_task_ids: ["learned-1"],
    trials: winning.map((t) => ({
      ...t,
      baseline: { ...t.baseline, cost_usd: 0 },
    })),
  });
  expect(free.cost_ratio).toBe(Number.POSITIVE_INFINITY);
  const dir = mkdtempSync(join(tmpdir(), "mars-skill-gates-"));
  try {
    const ledger = new SkillOutcomeLedger(join(dir, "outcomes.sqlite"));
    ledger.recordGate(free, 1);
    expect(ledger.gates("free")).toEqual([free]);
    ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a p-value exactly at alpha passes", () => {
  expect(signTestPValue(6, 0)).toBe(1 / 64);
  expect(
    evaluateSkillGate(
      { proposal_id: "p", evidence_task_ids: ["learned-1"], trials: winning },
      { alpha: 1 / 64 },
    ).passed,
  ).toBe(true);
});

test("the digest ignores the order of trials that share a task id", () => {
  const a = trial("dup", false, true);
  const b = trial("dup", true, false);
  const input = (trials: GateTrial[]) => ({
    proposal_id: "p",
    evidence_task_ids: ["learned-1"],
    trials,
  });
  expect(evaluateSkillGate(input([a, b])).digest).toBe(
    evaluateSkillGate(input([b, a])).digest,
  );
});

test("only verdicts as strict as the policy allow acceptance", () => {
  const input = {
    proposal_id: "p",
    evidence_task_ids: ["learned-1"],
    trials: winning,
  };
  const strict = evaluateSkillGate(input);
  expect(strict.options).toEqual({ ...GATE_POLICY });
  expect(meetsGatePolicy(strict)).toBe(true);
  expect(meetsGatePolicy(evaluateSkillGate(input, { max_cost_ratio: 1 }))).toBe(
    true,
  );
  const loose = evaluateSkillGate(input, { alpha: 0.5, min_trials: 2 });
  expect(loose.passed).toBe(true);
  expect(meetsGatePolicy(loose)).toBe(false);
  expect(meetsGatePolicy({ ...strict, passed: false })).toBe(false);
  const { options: _, ...legacy } = strict;
  expect(meetsGatePolicy(legacy as typeof strict)).toBe(false);
  expect(gateRequired([{ op: "archive" }, { op: "update" }])).toBe(true);
  expect(gateRequired([{ op: "archive" }, { op: "restore" }])).toBe(false);
});

test("acceptance requires a passing verdict or a recorded override", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mars-gated-accept-"));
  try {
    const store = new SkillStore(join(dir, "skills"));
    const ledger = new SkillOutcomeLedger(join(dir, "outcomes.sqlite"));
    const operator = { actor: "tanay", source: "operator" };
    const content = (name: string) =>
      `---\nname: ${name}\ndescription: How to ${name}.\n---\nDo it.\n`;
    const propose = (name: string) =>
      store.submitProposal({
        source: "background_review:s:r",
        rationale: name,
        ops: [{ op: "create", name, content: content(name) }],
      });

    const gated = await propose("gated");
    expect(describeGate(gated, ledger)).toBe("none yet");
    await expect(
      acceptWithGate(store, ledger, gated.id, operator),
    ).rejects.toMatchObject({ code: "gate-required" });
    const loose = evaluateSkillGate(
      { proposal_id: gated.id, evidence_task_ids: ["e"], trials: winning },
      { alpha: 0.5 },
    );
    ledger.recordGate(loose);
    await expect(
      acceptWithGate(store, ledger, gated.id, operator),
    ).rejects.toMatchObject({ code: "gate-required" });
    const failing = evaluateSkillGate({
      proposal_id: gated.id,
      evidence_task_ids: ["e"],
      trials: winning.slice(0, 5),
    });
    ledger.recordGate(failing, Date.now() + 1);
    expect(describeGate(gated, ledger)).toBe("failed: too-few-trials");
    const passing = evaluateSkillGate({
      proposal_id: gated.id,
      evidence_task_ids: ["e"],
      trials: winning,
    });
    ledger.recordGate(passing, Date.now() + 2);
    const accepted = await acceptWithGate(store, ledger, gated.id, operator);
    expect(accepted.gate?.digest).toBe(passing.digest);
    expect(accepted.overridden).toBe(false);
    expect((await store.get("gated"))?.status).toBe("active");

    const stale = await propose("stale");
    await store.create("stale", content("stale"), operator);
    await expect(
      acceptWithGate(store, ledger, stale.id, operator, { reason: "try" }),
    ).rejects.toMatchObject({ code: "stale-revision" });
    expect(describeGate(stale, ledger)).toBe("none yet");

    const skipped = await propose("skipped");
    await expect(
      acceptWithGate(store, ledger, skipped.id, operator, { reason: " " }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(await store.get("skipped")).toBeNull();
    const forced = await acceptWithGate(store, ledger, skipped.id, operator, {
      reason: "no model key yet",
    });
    expect(forced).toMatchObject({ gate: null, overridden: true });
    expect(ledger.gateOverrides(skipped.id)).toMatchObject([
      { actor: "tanay", reason: "no model key yet" },
    ]);
    expect(describeGate({ ...skipped, status: "accepted" }, ledger)).toBe(
      "accepted without gate by tanay: no model key yet",
    );

    const archival = await store.submitProposal({
      source: "outcome_gate",
      rationale: "harmful",
      ops: [{ op: "archive", name: "gated" }],
    });
    expect(describeGate(archival, ledger)).toBe("not required");
    expect(
      (await acceptWithGate(store, ledger, archival.id, operator)).gate,
    ).toBeNull();
    expect((await store.get("gated"))?.status).toBe("archived");
    expect(ledger.gateOverrides(archival.id)).toEqual([]);
    ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
