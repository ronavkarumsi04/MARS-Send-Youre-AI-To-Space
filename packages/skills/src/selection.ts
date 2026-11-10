import { parseFrontmatter } from "./frontmatter";

/** Verified-outcome evidence for one skill, as reported by `SkillOutcomeLedger.stats()`. */
export interface SkillOutcomeStats {
  name: string;
  /** Recorded tasks that loaded the skill and got a host verdict. */
  loads: number;
  /** Of those, how many passed host verification. */
  verified: number;
  /** Pass rate of recorded tasks that did not load the skill. */
  baseline_rate: number;
  /** Baseline sample size. */
  baseline_loads: number;
}

export interface RankableSkill {
  name: string;
  content: string;
  status: "active" | "stale" | "archived";
}

export interface RankedSkill {
  name: string;
  /** BM25 relevance to the task, normalized to [0, 1]. */
  relevance: number;
  /** Lower confidence bound on pass-rate lift over tasks without it, [-1, 1]; 0 without evidence. */
  helpfulness: number;
  /** 0.75 relevance + 0.25 helpfulness, times 0.8 if stale. */
  score: number;
  /** Max token overlap with skills picked before it; order is by score minus this (MMR). */
  redundancy: number;
}

export interface SkillRanking {
  ranked: RankedSkill[];
  /** Skills withheld because the evidence says they lower the pass rate. */
  quarantined: string[];
}

const STOPWORDS = new Set(
  "a an and are as at be by for from has have in is it its of on or that the this to was were will with you your i we our not do does".split(
    " ",
  ),
);
const MAX_TOKENS = 4_096;
/** Minimum loads before outcome evidence moves the ranking at all. */
export const MIN_SKILL_EVIDENCE = 3;
/** Minimum loads before a skill can be quarantined for hurting outcomes. */
export const MIN_QUARANTINE_EVIDENCE = 5;
const Z = 1.96;

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    tokens.push(raw);
    if (tokens.length >= MAX_TOKENS) break;
  }
  return tokens;
}

/** Wilson score interval for `successes / trials` at 95 % confidence. */
export function wilsonInterval(
  successes: number,
  trials: number,
): { lower: number; upper: number } {
  if (trials <= 0) return { lower: 0, upper: 1 };
  const p = successes / trials;
  const denominator = 1 + (Z * Z) / trials;
  const centre = p + (Z * Z) / (2 * trials);
  const margin =
    Z * Math.sqrt((p * (1 - p)) / trials + (Z * Z) / (4 * trials * trials));
  return {
    lower: Math.max(0, (centre - margin) / denominator),
    upper: Math.min(1, (centre + margin) / denominator),
  };
}

/**
 * Conservative lift: the pessimistic end of the skill's pass-rate interval
 * minus the optimistic end of the baseline's, so a skill only ranks up on
 * evidence that survives sampling noise on both sides. Returns 0 without
 * enough evidence.
 */
export function helpfulness(stats: SkillOutcomeStats | undefined): number {
  if (!stats || stats.loads < MIN_SKILL_EVIDENCE) return 0;
  const withSkill = wilsonInterval(stats.verified, stats.loads);
  const baseline = wilsonInterval(
    Math.round(stats.baseline_rate * stats.baseline_loads),
    stats.baseline_loads,
  );
  const optimisticLift = withSkill.upper - baseline.lower;
  const pessimisticLift = withSkill.lower - baseline.upper;
  if (pessimisticLift > 0) return pessimisticLift;
  if (optimisticLift < 0) return optimisticLift;
  return 0;
}

function quarantined(stats: SkillOutcomeStats | undefined): boolean {
  return (
    stats !== undefined &&
    stats.loads >= MIN_QUARANTINE_EVIDENCE &&
    stats.baseline_loads >= MIN_QUARANTINE_EVIDENCE &&
    helpfulness(stats) < 0
  );
}

function fields(skill: RankableSkill): string[] {
  const front = parseFrontmatter(skill.content);
  const name = tokenize(skill.name.replaceAll(/[-_]/g, " "));
  const description = tokenize(front?.description ?? "");
  // Name and description say what a procedure is for; weight them above the body.
  return [
    ...name,
    ...name,
    ...name,
    ...description,
    ...description,
    ...tokenize(skill.content),
  ];
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * Orders skills for one task: BM25 relevance to the task text, plus
 * conservative verified-outcome lift, minus redundancy with skills already
 * chosen (maximal marginal relevance). Deterministic for the same inputs;
 * archived skills are never ranked and skills whose evidence says they lower
 * the pass rate are quarantined instead of shown.
 */
export function rankSkills(
  skills: readonly RankableSkill[],
  query: string,
  stats: ReadonlyMap<string, SkillOutcomeStats> = new Map(),
  options: { diversity?: number } = {},
): SkillRanking {
  const diversity = options.diversity ?? 0.3;
  const quarantine: string[] = [];
  const candidates = skills
    .filter((skill) => skill.status !== "archived")
    .filter((skill) => {
      if (!quarantined(stats.get(skill.name))) return true;
      quarantine.push(skill.name);
      return false;
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const documents = candidates.map(fields);
  const averageLength =
    documents.reduce((sum, doc) => sum + doc.length, 0) /
      Math.max(1, documents.length) || 1;
  const frequency = new Map<string, number>();
  for (const doc of documents)
    for (const token of new Set(doc))
      frequency.set(token, (frequency.get(token) ?? 0) + 1);
  const queryTokens = [...new Set(tokenize(query))];
  const raw = documents.map((doc) => {
    const counts = new Map<string, number>();
    for (const token of doc) counts.set(token, (counts.get(token) ?? 0) + 1);
    let score = 0;
    for (const token of queryTokens) {
      const tf = counts.get(token) ?? 0;
      if (!tf) continue;
      const df = frequency.get(token) ?? 0;
      const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
      score +=
        (idf * tf * 2.2) /
        (tf + 1.2 * (0.25 + (0.75 * doc.length) / averageLength));
    }
    return score;
  });
  const top = Math.max(0, ...raw);
  const base = candidates.map((skill, index) => {
    const relevance = top > 0 ? (raw[index] ?? 0) / top : 0;
    const lift = helpfulness(stats.get(skill.name));
    const stalePenalty = skill.status === "stale" ? 0.8 : 1;
    return {
      name: skill.name,
      relevance,
      helpfulness: lift,
      score: (0.75 * relevance + 0.25 * lift) * stalePenalty,
      tokens: new Set(documents[index]),
    };
  });
  const ranked: RankedSkill[] = [];
  const chosen: Set<string>[] = [];
  const remaining = [...base];
  while (remaining.length) {
    let best = 0;
    let bestValue = Number.NEGATIVE_INFINITY;
    let bestRedundancy = 0;
    remaining.forEach((item, index) => {
      const redundancy = Math.max(
        0,
        ...chosen.map((tokens) => jaccard(item.tokens, tokens)),
      );
      const value = (1 - diversity) * item.score - diversity * redundancy;
      if (value > bestValue + 1e-12) {
        best = index;
        bestValue = value;
        bestRedundancy = redundancy;
      }
    });
    const [item] = remaining.splice(best, 1);
    if (!item) break;
    chosen.push(item.tokens);
    ranked.push({
      name: item.name,
      relevance: round(item.relevance),
      helpfulness: round(item.helpfulness),
      score: round(item.score),
      redundancy: round(bestRedundancy),
    });
  }
  return { ranked, quarantined: quarantine.sort() };
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
