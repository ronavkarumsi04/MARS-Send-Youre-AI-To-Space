import { createHash } from "node:crypto";
import { wilsonInterval } from "@mars/skills";

export { wilsonInterval };

/**
 * Deterministic PRNG from a string seed (sha256 → xoshiro128**), the same
 * construction `@mars/evolution` uses; inlined because `@mars/evolution`
 * depends on this package.
 */
export function seededRandom(seed: string): () => number {
  const digest = createHash("sha256").update(seed).digest();
  let a = digest.readUInt32LE(0);
  let b = digest.readUInt32LE(4);
  let c = digest.readUInt32LE(8);
  let d = digest.readUInt32LE(12);
  if ((a | b | c | d) === 0) a = 1;
  return () => {
    const result = Math.imul(rotl(Math.imul(b, 5), 7), 9) >>> 0;
    const t = (b << 9) >>> 0;
    c ^= a;
    d ^= b;
    b ^= c;
    a ^= d;
    c ^= t;
    d = rotl(d, 11);
    return result / 0x1_0000_0000;
  };
}

function rotl(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

export interface RatioInterval {
  estimate: number | null;
  low: number | null;
  high: number | null;
  confidence: number;
  samples: number;
  method: "task-bootstrap-percentile";
}

/**
 * Percentile bootstrap of `sum(numerators) / sum(denominators)` with tasks as
 * the resampling unit (e.g. cost per verified solve: cost over solves).
 * Resamples with no solves are skipped; the interval is null when the point
 * estimate is undefined or fewer than two tasks exist.
 */
export function bootstrapRatio(
  units: ReadonlyArray<{ numerator: number; denominator: number }>,
  options: { seed: string; samples?: number; confidence?: number },
): RatioInterval {
  const samples = options.samples ?? 2000;
  const confidence = options.confidence ?? 0.95;
  const total = (
    rows: ReadonlyArray<{ numerator: number; denominator: number }>,
  ) =>
    rows.reduce(
      (acc, row) => ({
        numerator: acc.numerator + row.numerator,
        denominator: acc.denominator + row.denominator,
      }),
      { numerator: 0, denominator: 0 },
    );
  const all = total(units);
  const estimate = all.denominator > 0 ? all.numerator / all.denominator : null;
  const base = {
    estimate,
    confidence,
    samples,
    method: "task-bootstrap-percentile" as const,
  };
  if (estimate === null || units.length < 2)
    return { ...base, low: null, high: null };
  const random = seededRandom(options.seed);
  const ratios: number[] = [];
  for (let i = 0; i < samples; i += 1) {
    let numerator = 0;
    let denominator = 0;
    for (let j = 0; j < units.length; j += 1) {
      const unit = units[Math.floor(random() * units.length)] as {
        numerator: number;
        denominator: number;
      };
      numerator += unit.numerator;
      denominator += unit.denominator;
    }
    if (denominator > 0) ratios.push(numerator / denominator);
  }
  if (ratios.length === 0) return { ...base, low: null, high: null };
  ratios.sort((x, y) => x - y);
  const alpha = 1 - confidence;
  const at = (q: number) =>
    ratios[
      Math.min(
        ratios.length - 1,
        Math.max(0, Math.floor(q * (ratios.length - 1))),
      )
    ] as number;
  return { ...base, low: at(alpha / 2), high: at(1 - alpha / 2) };
}

/**
 * Exact two-sided binomial sign test on discordant pairs: `wins` tasks where
 * only the candidate solved, `losses` where only the baseline solved.
 * p = min(1, 2·P[X ≥ max(wins, losses)]) with X ~ Binomial(n, 1/2).
 */
export function exactSignTest(
  wins: number,
  losses: number,
): { n: number; wins: number; losses: number; p_two_sided: number } {
  const n = wins + losses;
  if (n === 0) return { n, wins, losses, p_two_sided: 1 };
  const k = Math.max(wins, losses);
  let logChoose = 0;
  const terms: number[] = [];
  for (let i = 0; i <= n; i += 1) {
    if (i > 0) logChoose += Math.log(n - i + 1) - Math.log(i);
    if (i >= k) terms.push(logChoose);
  }
  const tail = terms.reduce(
    (sum, log) => sum + Math.exp(log - n * Math.LN2),
    0,
  );
  return { n, wins, losses, p_two_sided: Math.min(1, 2 * tail) };
}
