import type { SelectionMethod } from "./schemas";
import { weightedChoice } from "./util";

/** One archive member as parent selection sees it (selection-split data only). */
export interface ArchiveMember {
  candidate_id: string;
  parent_id: string | null;
  /** Strict selection score in [0, 1] (DGM `accuracy_score`). */
  score: number;
  /** DGM `is_compiled_self_improve`: built, first stage complete, ≥1 valid trial. */
  eligible: boolean;
  /** Insertion order in the archive. */
  seq: number;
  /** Selection tasks the candidate did not solve on every repeat. */
  unresolved: readonly string[];
  /** Selection tasks whose repeats disagreed. */
  unstable: readonly string[];
}

export interface SelectionOptions {
  lambda: number;
  midpoint: number;
}

/** DGM counts children among archive members whose parent is also an archive member. */
export function childrenCounts(
  archive: readonly ArchiveMember[],
): Map<string, number> {
  const counts = new Map(archive.map((member) => [member.candidate_id, 0]));
  for (const member of archive) {
    if (member.parent_id !== null && counts.has(member.parent_id))
      counts.set(member.parent_id, (counts.get(member.parent_id) ?? 0) + 1);
  }
  return counts;
}

export function sigmoidScore(score: number, options: SelectionOptions): number {
  return 1 / (1 + Math.exp(-options.lambda * (score - options.midpoint)));
}

/**
 * Normalised parent probabilities for the weighted methods, exactly as
 * DGM_outer.choose_selfimproves computes them:
 * `score_prop` p ∝ sigmoid(λ(α − α0)); `score_child_prop` additionally
 * multiplies by 1 / (1 + children). Only eligible members are candidates.
 */
export function parentProbabilities(
  archive: readonly ArchiveMember[],
  method: "score_prop" | "score_child_prop",
  options: SelectionOptions,
): Map<string, number> {
  const eligible = archive.filter((member) => member.eligible);
  const counts = childrenCounts(archive);
  const weights = eligible.map((member) => {
    const scoreWeight = sigmoidScore(member.score, options);
    return method === "score_child_prop"
      ? scoreWeight / (1 + (counts.get(member.candidate_id) ?? 0))
      : scoreWeight;
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return new Map(
    eligible.map((member, index) => [
      member.candidate_id,
      total > 0 ? (weights[index] as number) / total : 1 / eligible.length,
    ]),
  );
}

/**
 * Picks `k` parents (with replacement, like `random.choices`). `best` takes
 * the highest scores — upstream sorts ascending and so picks the lowest,
 * which we treat as a bug — and pads by re-drawing among the chosen.
 * `latest` is DGM's `no_darwin` baseline (always the newest eligible member).
 */
export function selectParents(
  archive: readonly ArchiveMember[],
  k: number,
  method: SelectionMethod,
  options: SelectionOptions,
  random: () => number,
): string[] {
  const eligible = archive.filter((member) => member.eligible);
  if (eligible.length === 0) return [];
  if (method === "latest") {
    const newest = [...eligible].sort(
      (a, b) => b.seq - a.seq,
    )[0] as ArchiveMember;
    return Array.from({ length: k }, () => newest.candidate_id);
  }
  if (method === "random")
    return Array.from(
      { length: k },
      () =>
        eligible[Math.floor(random() * eligible.length)]
          ?.candidate_id as string,
    );
  if (method === "best") {
    const sorted = [...eligible].sort(
      (a, b) => b.score - a.score || a.seq - b.seq,
    );
    const chosen = sorted
      .slice(0, Math.min(k, sorted.length))
      .map((m) => m.candidate_id);
    while (chosen.length < k)
      chosen.push(chosen[Math.floor(random() * chosen.length)] as string);
    return chosen;
  }
  const probabilities = parentProbabilities(archive, method, options);
  const ids = [...probabilities.keys()];
  const weights = ids.map((id) => probabilities.get(id) as number);
  return Array.from({ length: k }, () => weightedChoice(ids, weights, random));
}

export type SelfImproveEntry =
  | { kind: "solve_stochasticity" }
  | { kind: "task"; task_id: string }
  | { kind: "explore" };

/**
 * DGM entry choice: with probability 0.25 target stochasticity when the
 * parent has disagreeing repeats; otherwise a random unresolved selection
 * task; `explore` when the parent solved everything.
 */
export function chooseEntry(
  parent: ArchiveMember,
  random: () => number,
): SelfImproveEntry {
  if (parent.unstable.length > 0 && random() < 0.25)
    return { kind: "solve_stochasticity" };
  if (parent.unresolved.length === 0) return { kind: "explore" };
  return {
    kind: "task",
    task_id: parent.unresolved[
      Math.floor(random() * parent.unresolved.length)
    ] as string,
  };
}

/** DGM `update_archive`: keep_all, or keep_better (≥ initial − noise_leeway). */
export function admitToArchive(
  score: number,
  initialScore: number,
  method: "keep_all" | "keep_better",
  noiseLeeway: number,
): boolean {
  return method === "keep_all" || score >= initialScore - noiseLeeway;
}
