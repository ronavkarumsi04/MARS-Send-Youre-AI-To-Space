import type { Interval } from "./schemas";
import { seededRandom } from "./util";

/** Mean where invalid (null) or missing repeats count as 0. */
export function strictMean(
  rewards: readonly (number | null)[],
  repeats: number,
): number {
  const divisor = Math.max(repeats, rewards.length);
  if (divisor === 0) return 0;
  return (
    rewards.reduce<number>((sum, reward) => sum + (reward ?? 0), 0) / divisor
  );
}

export function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Paired percentile-bootstrap interval of the mean per-task difference.
 * Tasks are the resampling unit (repeats are already averaged per task).
 * Fewer than two tasks give the uninformative interval [-1, 1], so a gate
 * can never pass on a single noisy task.
 */
export function pairedInterval(
  differences: readonly number[],
  options: { confidence: number; samples: number; seed: string },
): Interval {
  const n = differences.length;
  const center = mean(differences);
  if (n < 2)
    return {
      n,
      mean: center,
      std_error: 0,
      low: -1,
      high: 1,
      confidence: options.confidence,
      method: "paired-bootstrap-percentile",
    };
  const variance =
    differences.reduce((sum, value) => sum + (value - center) ** 2, 0) /
    (n - 1);
  const random = seededRandom(options.seed);
  const means: number[] = [];
  for (let sample = 0; sample < options.samples; sample += 1) {
    let total = 0;
    for (let draw = 0; draw < n; draw += 1)
      total += differences[Math.floor(random() * n)] as number;
    means.push(total / n);
  }
  means.sort((a, b) => a - b);
  const alpha = 1 - options.confidence;
  const at = (q: number) =>
    means[
      Math.min(
        means.length - 1,
        Math.max(0, Math.floor(q * (means.length - 1))),
      )
    ] as number;
  return {
    n,
    mean: center,
    std_error: Math.sqrt(variance / n),
    low: at(alpha / 2),
    high: at(1 - alpha / 2),
    confidence: options.confidence,
    method: "paired-bootstrap-percentile",
  };
}
