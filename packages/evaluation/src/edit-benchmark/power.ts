import { exactSignTest } from "./stats";

/**
 * Exact power of the pre-registered paired sign test (no normal
 * approximation). With `n` tasks, each task is discordant with probability
 * `discordance`; a discordant task favours MARS with probability `share`. The
 * test rejects when MARS has more discordant wins and the exact two-sided
 * binomial p-value is below `alpha`.
 */
export function signTestPower(
  n: number,
  discordance: number,
  share: number,
  alpha = 0.05,
): number {
  let power = 0;
  for (let discordant = 0; discordant <= n; discordant += 1) {
    const pd = binomial(n, discordant, discordance);
    let reject = 0;
    for (
      let wins = Math.floor(discordant / 2) + 1;
      wins <= discordant;
      wins += 1
    )
      if (exactSignTest(wins, discordant - wins).p_two_sided < alpha)
        reject += binomial(discordant, wins, share);
    power += pd * reject;
  }
  return power;
}

/**
 * Smallest task count whose power reaches `target` and stays there for the
 * next `window` counts (discrete tests are not monotone in n).
 */
export function minimumPoweredTasks(
  discordance: number,
  share: number,
  options: {
    alpha?: number;
    target?: number;
    window?: number;
    max?: number;
  } = {},
): number | null {
  const { alpha = 0.05, target = 0.8, window = 10, max = 1000 } = options;
  const powers = new Map<number, number>();
  const at = (n: number) => {
    let value = powers.get(n);
    if (value === undefined) {
      value = signTestPower(n, discordance, share, alpha);
      powers.set(n, value);
    }
    return value;
  };
  for (let n = 1; n <= max; n += 1) {
    let ok = true;
    for (let m = n; m <= n + window && ok; m += 1) ok = at(m) >= target;
    if (ok) return n;
  }
  return null;
}

/**
 * Pre-registered design point (amendment 2026-11-14, before any live run):
 * MARS wins 70% of discordant tasks and 40% of tasks are discordant, alpha
 * 0.05, 80% power. Suites smaller than this are exploratory.
 */
export const POWER_DESIGN = {
  discordance: 0.4,
  share: 0.7,
  alpha: 0.05,
  target: 0.8,
} as const;
export const MIN_POWERED_TASKS = 129;

function logChoose(n: number, k: number): number {
  let total = 0;
  for (let i = 1; i <= k; i += 1) total += Math.log(n - k + i) - Math.log(i);
  return total;
}

function binomial(n: number, k: number, p: number): number {
  if (p <= 0) return k === 0 ? 1 : 0;
  if (p >= 1) return k === n ? 1 : 0;
  return Math.exp(
    logChoose(n, k) + k * Math.log(p) + (n - k) * Math.log(1 - p),
  );
}
