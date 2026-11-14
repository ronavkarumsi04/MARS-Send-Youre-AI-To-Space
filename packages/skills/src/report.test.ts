import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GateTrial } from "./gate";
import { SkillOutcomeLedger, type SkillTrialRow } from "./outcomes";
import { skillEvidenceReport } from "./report";
import { wilsonInterval } from "./selection";

function pairs(
  wins = 6,
  losses = 0,
  count = 10,
  candidateCost = 1,
): SkillTrialRow[] {
  return Array.from({ length: count }, (_, i) => ({
    scope_key: "repo",
    skill: "imported",
    recorded_at: 1,
    task_id: `t${i}`,
    baseline: { verified: i >= wins, cost_usd: 1 },
    candidate: {
      verified: i < wins || i >= wins + losses,
      cost_usd: candidateCost,
    },
  }));
}

test("held-out pairs alone establish helps, hurts, insufficient evidence and cost regression", () => {
  for (const [trials, verdict] of [
    [pairs(), "helps"],
    [pairs(0, 6), "hurts"],
    [pairs(6, 0, 6), "no_evidence"],
    [pairs(0, 0, 10, 2), "hurts"],
    [pairs(6, 1), "no_evidence"],
    [pairs(6, 0, 10, 2), "no_evidence"],
  ] as const) {
    const [entry] = skillEvidenceReport({ outcomes: [], trials });
    expect(entry?.verdict).toBe(verdict);
  }
  const [help] = skillEvidenceReport({ outcomes: [], trials: pairs() });
  expect(help?.held_out.p_value).toBe(1 / 64);
  expect(help?.held_out.reasons).toEqual([]);
  const [cost] = skillEvidenceReport({
    outcomes: [],
    trials: pairs(0, 0, 10, 2),
  });
  expect(cost?.held_out.reasons).toContain("cost");
  expect(cost?.held_out.candidate_cost_per_verified_solve).toBe(2);
});

test("invalid and duplicate pairs cannot establish a verdict; infinity survives JSON", () => {
  const duplicate = pairs();
  duplicate.push(duplicate[0] as SkillTrialRow);
  expect(
    skillEvidenceReport({ outcomes: [], trials: duplicate })[0]?.verdict,
  ).toBe("no_evidence");
  const invalid = pairs().map((pair) => ({
    ...pair,
    candidate: { ...pair.candidate, cost_usd: -1 },
  }));
  expect(
    skillEvidenceReport({ outcomes: [], trials: invalid })[0]?.held_out.reasons,
  ).toContain("invalid-trial");
  expect(
    skillEvidenceReport({ outcomes: [], trials: invalid })[0]?.verdict,
  ).toBe("no_evidence");
  const free = pairs(0, 0).map((pair) => ({
    ...pair,
    baseline: { ...pair.baseline, cost_usd: 0 },
  }));
  const [entry] = JSON.parse(
    JSON.stringify(skillEvidenceReport({ outcomes: [], trials: free })),
  );
  expect(entry.verdict).toBe("hurts");
  expect(entry.held_out.cost_ratio).toBeNull();
  expect(entry.held_out.cost_ratio_infinite).toBe(true);
  expect(skillEvidenceReport({ outcomes: [], trials: [] })).toEqual([]);
});

test("unscoped provenance applies across scopes and scoped provenance takes precedence", () => {
  const trials = [
    ...pairs(),
    ...pairs().map((pair) => ({ ...pair, scope_key: "other" })),
  ];
  const report = skillEvidenceReport({
    outcomes: [],
    trials,
    provenance: [
      { skill: "imported", provenance: { origin: ".agents/skills" } },
      { scope_key: "repo", skill: "imported", provenance: { origin: "store" } },
    ],
  });
  expect(report.map((entry) => entry.provenance?.origin)).toEqual([
    ".agents/skills",
    "store",
  ]);
});

test("fixture ledger supports imported skills, observational costs, scopes, and trial replacement", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-report-"));
  const ledger = new SkillOutcomeLedger(join(dir, "outcomes.sqlite"));
  try {
    const skills = [{ name: "imported", sha256: "a".repeat(64) }];
    ledger.record({
      scope_key: "repo",
      task_id: "a",
      skills,
      verified: true,
      cost_usd: 2,
      recorded_at: 1,
    });
    ledger.record({
      scope_key: "repo",
      task_id: "b",
      skills: [],
      verified: false,
      cost_usd: 3,
      recorded_at: 1,
    });
    ledger.record({
      scope_key: "other",
      task_id: "a",
      skills,
      verified: false,
      recorded_at: 1,
    });
    ledger.recordTrials(
      "repo",
      "imported",
      pairs().map(({ task_id, baseline, candidate }) => ({
        task_id,
        baseline,
        candidate,
      })),
      2,
    );
    const replacement: GateTrial = {
      task_id: "t0",
      baseline: { verified: false, cost_usd: 1 },
      candidate: { verified: true, cost_usd: 1 },
    };
    ledger.recordTrials("repo", "imported", [replacement], 3);
    expect(ledger.trials("repo", "imported")).toHaveLength(10);
    expect(ledger.trials("repo")[0]?.recorded_at).toBe(3);
    expect(ledger.trials(undefined, "missing")).toEqual([]);
    expect(ledger.outcomes("repo")).toHaveLength(2);
    const entries = skillEvidenceReport({
      outcomes: ledger.outcomes(),
      trials: ledger.trials(),
      provenance: [
        {
          scope_key: "repo",
          skill: "imported",
          provenance: {
            origin: ".agents/skills",
            path: ".agents/skills/imported/SKILL.md",
            lock: { hash: "abc" },
          },
        },
      ],
    });
    expect(entries.map((entry) => entry.scope_key)).toEqual(["other", "repo"]);
    const [other, repo] = entries;
    expect(other?.with.cost_usd).toBeNull();
    expect(other?.with.cost_per_verified_solve).toBeNull();
    expect(other?.without.rate).toBeNull();
    expect(other?.difference).toBeNull();
    expect(other?.provenance).toBeNull();
    expect(other?.verdict).toBe("no_evidence");
    expect(other?.held_out.trials).toBe(0);
    expect(repo?.verdict).toBe("helps");
    expect(repo?.provenance?.origin).toBe(".agents/skills");
    expect(repo?.versions).toEqual(["a".repeat(64)]);
    expect(repo?.with.interval).toEqual(wilsonInterval(1, 1));
    expect(repo?.with.interval.lower).toBeCloseTo(0.20654, 4);
    expect(repo?.difference).toBe(1);
    expect(repo?.with.cost_per_verified_solve).toBe(2);
    expect(repo?.without.cost_usd).toBe(3);
    expect(repo?.without.cost_per_verified_solve).toBeNull();
    for (const cost_usd of [-1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() =>
        ledger.record({
          task_id: "bad",
          skills,
          verified: false,
          cost_usd,
          recorded_at: 1,
        }),
      ).toThrow();
    expect(() =>
      ledger.recordTrials("repo", "../bad", [replacement]),
    ).toThrow();
    expect(() =>
      ledger.recordTrials("repo", "imported", [replacement, replacement]),
    ).toThrow();
    expect(() =>
      ledger.recordTrials("repo", "imported", [
        { ...replacement, baseline: { verified: true, cost_usd: -1 } },
      ]),
    ).toThrow();
    ledger.recordTrials("repo", "imported", []);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migrates existing scoped databases without losing outcomes or changing stats", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-report-migration-"));
  const path = join(dir, "outcomes.sqlite");
  const db = new Database(path);
  db.exec(
    "CREATE TABLE skill_outcomes (scope_key TEXT, task_id TEXT, skills TEXT, verified INTEGER, recorded_at INTEGER, PRIMARY KEY(scope_key, task_id))",
  );
  db.query("INSERT INTO skill_outcomes VALUES (?, ?, ?, ?, ?)").run(
    "repo",
    "old",
    JSON.stringify([{ name: "imported", sha256: "a".repeat(64) }]),
    1,
    7,
  );
  db.close();
  const ledger = new SkillOutcomeLedger(path);
  const reopened = new SkillOutcomeLedger(path);
  try {
    expect(ledger.outcomes()[0]?.cost_usd).toBeNull();
    expect(ledger.outcomes()[0]?.recorded_at).toBe(7);
    expect(ledger.stats().get("imported")?.verified).toBe(1);
    ledger.record({
      scope_key: "repo",
      task_id: "old",
      skills: [],
      verified: false,
      cost_usd: 0,
      recorded_at: 8,
    });
    expect(ledger.outcomes()[0]?.cost_usd).toBe(0);
    expect(reopened.outcomes()).toEqual(ledger.outcomes());
    reopened.recordTrials(
      "repo",
      "imported",
      pairs().map(({ task_id, baseline, candidate }) => ({
        task_id,
        baseline,
        candidate,
      })),
    );
    expect(ledger.trials("repo", "imported")).toHaveLength(10);
  } finally {
    reopened.close();
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
