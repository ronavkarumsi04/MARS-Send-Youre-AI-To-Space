import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SkillOutcomeStats } from "./selection";

/** One loaded skill, bound to the exact content the task saw. */
export interface LoadedSkill {
  name: string;
  sha256: string;
}

export interface SkillOutcome {
  /** Task ids are unique only within a scope; defaults to "". */
  scope_key?: string;
  task_id: string;
  skills: readonly LoadedSkill[];
  /** The host's verdict for the task's exact candidate. */
  verified: boolean;
  recorded_at: number;
}

export interface SkillOutcomeView extends SkillOutcomeStats {
  /** Distinct content versions of the skill that tasks loaded. */
  versions: number;
}

const MAX_SKILLS_PER_TASK = 1_024;
const SHA256 = /^[a-f0-9]{64}$/;

/**
 * Durable record of which skill versions each verified task loaded and what
 * the host's verdict was. One row per task: a re-verified task replaces its
 * earlier verdict instead of counting twice. Only host verdicts are recorded,
 * so model self-reports never become learning signal.
 */
export class SkillOutcomeLedger {
  private readonly db: Database;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS skill_outcomes (
        scope_key TEXT NOT NULL,
        task_id TEXT NOT NULL,
        skills TEXT NOT NULL,
        verified INTEGER NOT NULL CHECK (verified IN (0, 1)),
        recorded_at INTEGER NOT NULL,
        PRIMARY KEY (scope_key, task_id)
      )`,
    );
  }

  record(outcome: SkillOutcome): void {
    if (!outcome.task_id || outcome.task_id.length > 256)
      throw new Error("Invalid task id.");
    const scopeKey = outcome.scope_key ?? "";
    if (scopeKey.length > 1_024) throw new Error("Invalid scope key.");
    if (outcome.skills.length > MAX_SKILLS_PER_TASK)
      throw new Error("Too many skills.");
    const names = new Set<string>();
    for (const skill of outcome.skills) {
      if (!skill.name || skill.name.length > 128 || !SHA256.test(skill.sha256))
        throw new Error("Invalid loaded skill.");
      if (names.has(skill.name)) throw new Error("Duplicate loaded skill.");
      names.add(skill.name);
    }
    this.db
      .query(
        `INSERT INTO skill_outcomes (scope_key, task_id, skills, verified, recorded_at)
         VALUES ($scope_key, $task_id, $skills, $verified, $recorded_at)
         ON CONFLICT(scope_key, task_id) DO UPDATE SET
           skills = excluded.skills,
           verified = excluded.verified,
           recorded_at = excluded.recorded_at`,
      )
      .run({
        scope_key: scopeKey,
        task_id: outcome.task_id,
        skills: JSON.stringify(outcome.skills),
        verified: outcome.verified ? 1 : 0,
        recorded_at: outcome.recorded_at,
      });
  }

  /** Per-skill evidence with each skill's own baseline: recorded tasks that did not load it. */
  stats(): Map<string, SkillOutcomeView> {
    const rows = this.db
      .query("SELECT skills, verified FROM skill_outcomes")
      .all() as { skills: string; verified: number }[];
    let total = 0;
    let totalVerified = 0;
    const perSkill = new Map<
      string,
      { loads: number; verified: number; versions: Set<string> }
    >();
    for (const row of rows) {
      total++;
      totalVerified += row.verified;
      for (const skill of JSON.parse(row.skills) as LoadedSkill[]) {
        const entry = perSkill.get(skill.name) ?? {
          loads: 0,
          verified: 0,
          versions: new Set<string>(),
        };
        entry.loads++;
        entry.verified += row.verified;
        entry.versions.add(skill.sha256);
        perSkill.set(skill.name, entry);
      }
    }
    const stats = new Map<string, SkillOutcomeView>();
    for (const [name, entry] of perSkill) {
      const baselineLoads = total - entry.loads;
      stats.set(name, {
        name,
        loads: entry.loads,
        verified: entry.verified,
        baseline_loads: baselineLoads,
        baseline_rate: baselineLoads
          ? (totalVerified - entry.verified) / baselineLoads
          : 0,
        versions: entry.versions.size,
      });
    }
    return stats;
  }

  close(): void {
    this.db.close();
  }
}
