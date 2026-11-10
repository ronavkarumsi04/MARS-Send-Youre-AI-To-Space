import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillOutcomeLedger } from "./outcomes";
import {
  helpfulness,
  type RankableSkill,
  rankSkills,
  type SkillOutcomeStats,
  wilsonInterval,
} from "./selection";

const skill = (
  name: string,
  description: string,
  body: string,
  status: RankableSkill["status"] = "active",
): RankableSkill => ({
  name,
  status,
  content: `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`,
});
const sha = (char: string) => char.repeat(64);

test("relevance ranks the procedure for this task first, deterministically, and never ranks archived skills", () => {
  const skills = [
    skill(
      "release-notes",
      "Write release notes from merged PRs.",
      "Collect merged pull requests since the last tag.",
    ),
    skill(
      "flaky-tests",
      "Diagnose flaky tests.",
      "Rerun the failing test in isolation and look for timers.",
    ),
    skill(
      "old",
      "Diagnose flaky tests the old way.",
      "Rerun flaky test.",
      "archived",
    ),
  ];
  const query =
    "The checkout test is flaky in CI; diagnose and fix the failing test.";
  const first = rankSkills(skills, query);
  expect(first.ranked.map((r) => r.name)).toEqual([
    "flaky-tests",
    "release-notes",
  ]);
  expect(first.ranked[0]?.relevance).toBe(1);
  expect(first.ranked[1]?.relevance).toBe(0);
  expect(rankSkills([...skills].reverse(), query)).toEqual(first);
});

test("diversity keeps a near-duplicate of the top skill from crowding out a different relevant one", () => {
  const body =
    "Rerun the failing test in isolation, look for timers and shared state.";
  const skills = [
    skill("flaky-a", "Diagnose flaky tests.", body),
    skill("flaky-b", "Diagnose flaky tests.", `${body} Again.`),
    skill(
      "ci-logs",
      "Read CI logs for a failing test.",
      "Download the CI log and find the first error.",
    ),
  ];
  const ranked = rankSkills(
    skills,
    "diagnose the failing flaky test from CI logs",
  ).ranked;
  const order = ranked.map((r) => r.name);
  expect(order.indexOf("ci-logs")).toBeLessThan(2);
  // The recorded fields reproduce the order: MMR value never increases.
  const values = ranked.map((r) => 0.7 * r.score - 0.3 * r.redundancy);
  expect(ranked[0]?.redundancy).toBe(0);
  expect(ranked.at(-1)?.redundancy).toBeGreaterThan(0);
  for (let i = 1; i < values.length; i++)
    expect(values[i] ?? 0).toBeLessThanOrEqual((values[i - 1] ?? 0) + 1e-6);
});

test("outcome evidence only counts once it survives sampling noise, and harmful skills are quarantined", () => {
  const stats = (
    loads: number,
    verified: number,
    baselineLoads: number,
    baselineRate: number,
  ): SkillOutcomeStats => ({
    name: "s",
    loads,
    verified,
    baseline_loads: baselineLoads,
    baseline_rate: baselineRate,
  });
  expect(helpfulness(undefined)).toBe(0);
  expect(helpfulness(stats(2, 2, 50, 0.1))).toBe(0);
  expect(helpfulness(stats(5, 3, 5, 0.4))).toBe(0);
  expect(helpfulness(stats(40, 38, 40, 0.3))).toBeGreaterThan(0);
  expect(helpfulness(stats(40, 2, 40, 0.9))).toBeLessThan(0);
  const { lower, upper } = wilsonInterval(5, 10);
  expect(lower).toBeGreaterThan(0.18);
  expect(upper).toBeLessThan(0.82);

  const skills = [
    skill("helps", "Fix failing builds.", "Steps."),
    skill("hurts", "Fix failing builds.", "Steps that mislead."),
  ];
  const evidence = new Map([
    ["helps", { ...stats(40, 38, 40, 0.3), name: "helps" }],
    ["hurts", { ...stats(40, 2, 40, 0.9), name: "hurts" }],
  ]);
  const ranking = rankSkills(skills, "fix the failing build", evidence);
  expect(ranking.ranked.map((r) => r.name)).toEqual(["helps"]);
  expect(ranking.quarantined).toEqual(["hurts"]);
});

test("the outcome ledger credits each task once, with each skill compared to tasks that did not load it", () => {
  const dir = mkdtempSync(join(tmpdir(), "mars-skill-outcomes-"));
  const path = join(dir, "nested", "outcomes.sqlite");
  try {
    const ledger = new SkillOutcomeLedger(path);
    expect(statSync(path).mode & 0o077).toBe(0);
    ledger.record({
      task_id: "t1",
      skills: [{ name: "a", sha256: sha("1") }],
      verified: true,
      recorded_at: 1,
    });
    ledger.record({
      task_id: "t2",
      skills: [
        { name: "a", sha256: sha("2") },
        { name: "b", sha256: sha("3") },
      ],
      verified: false,
      recorded_at: 2,
    });
    ledger.record({
      task_id: "t3",
      skills: [],
      verified: true,
      recorded_at: 3,
    });
    ledger.record({
      task_id: "t2",
      skills: [
        { name: "a", sha256: sha("2") },
        { name: "b", sha256: sha("3") },
      ],
      verified: true,
      recorded_at: 4,
    });
    ledger.close();
    const reopened = new SkillOutcomeLedger(path);
    const stats = reopened.stats();
    expect(stats.get("a")).toEqual({
      name: "a",
      loads: 2,
      verified: 2,
      baseline_loads: 1,
      baseline_rate: 1,
      versions: 2,
    });
    expect(stats.get("b")).toEqual({
      name: "b",
      loads: 1,
      verified: 1,
      baseline_loads: 2,
      baseline_rate: 1,
      versions: 1,
    });
    expect(() =>
      reopened.record({
        task_id: "t4",
        skills: [{ name: "a", sha256: "nope" }],
        verified: true,
        recorded_at: 5,
      }),
    ).toThrow();
    expect(() =>
      reopened.record({
        task_id: "t4",
        skills: [
          { name: "a", sha256: sha("1") },
          { name: "a", sha256: sha("2") },
        ],
        verified: true,
        recorded_at: 5,
      }),
    ).toThrow("Duplicate");
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the outcome ledger keeps the same task id in different scopes apart", () => {
  const dir = mkdtempSync(join(tmpdir(), "mars-skill-outcomes-"));
  try {
    const ledger = new SkillOutcomeLedger(join(dir, "outcomes.sqlite"));
    for (const [scope_key, verified] of [
      ["owner-a", true],
      ["owner-b", false],
    ] as const)
      ledger.record({
        scope_key,
        task_id: "t1",
        skills: [{ name: "a", sha256: sha("1") }],
        verified,
        recorded_at: 1,
      });
    expect(ledger.stats().get("a")).toMatchObject({ loads: 2, verified: 1 });
    ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unscoped outcome database is migrated on open and keeps learning", () => {
  const dir = mkdtempSync(join(tmpdir(), "mars-skill-outcomes-"));
  const path = join(dir, "outcomes.sqlite");
  try {
    const old = new Database(path, { create: true });
    old.exec(
      "CREATE TABLE skill_outcomes (task_id TEXT PRIMARY KEY, skills TEXT NOT NULL, verified INTEGER NOT NULL, recorded_at INTEGER NOT NULL)",
    );
    old
      .query("INSERT INTO skill_outcomes VALUES (?, ?, 1, 1)")
      .run("t1", JSON.stringify([{ name: "a", sha256: sha("1") }]));
    old.close();
    const ledger = new SkillOutcomeLedger(path);
    ledger.record({
      scope_key: "owner-a",
      task_id: "t1",
      skills: [{ name: "a", sha256: sha("1") }],
      verified: false,
      recorded_at: 2,
    });
    expect(ledger.stats().get("a")).toMatchObject({ loads: 2, verified: 1 });
    ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
