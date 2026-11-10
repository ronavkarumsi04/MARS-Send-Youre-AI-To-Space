import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateSkillGate,
  type GateTrial,
  harmfulSkillArchivals,
  signTestPValue,
} from "./gate";
import { SkillOutcomeLedger } from "./outcomes";

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
