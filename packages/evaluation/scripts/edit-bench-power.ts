/**
 * Exact power of the pre-registered paired sign test for the edit-format
 * benchmark (no normal approximations). With N tasks, each task is discordant
 * with probability `d`; a discordant task favours MARS with probability `w`.
 * The test rejects when MARS has more discordant wins and the exact
 * two-sided binomial p-value is < alpha.
 *
 *   bun packages/evaluation/scripts/edit-bench-power.ts [--json]
 */
import { exactSignTest } from "../src/edit-benchmark/stats";

const ALPHA = 0.05;
const TARGET = 0.8;

function logChoose(n: number, k: number): number {
  let total = 0;
  for (let i = 1; i <= k; i += 1) total += Math.log(n - k + i) - Math.log(i);
  return total;
}
const binom = (n: number, k: number, p: number) =>
  p === 0
    ? k === 0
      ? 1
      : 0
    : p === 1
      ? k === n
        ? 1
        : 0
      : Math.exp(logChoose(n, k) + k * Math.log(p) + (n - k) * Math.log(1 - p));

/** Power for N tasks, discordance rate d, MARS share of discordant tasks w. */
export function signTestPower(
  n: number,
  d: number,
  w: number,
  alpha = ALPHA,
): number {
  let power = 0;
  for (let discordant = 0; discordant <= n; discordant += 1) {
    const pd = binom(n, discordant, d);
    if (pd < 1e-15) continue;
    let reject = 0;
    for (let wins = 0; wins <= discordant; wins += 1) {
      const losses = discordant - wins;
      if (wins > losses && exactSignTest(wins, losses).p_two_sided < alpha)
        reject += binom(discordant, wins, w);
    }
    power += pd * reject;
  }
  return power;
}

/** Smallest N whose power, and the power of every N up to N + 10, reaches the target. */
export function minimumTasks(d: number, w: number, max = 1000): number | null {
  for (let n = 1; n <= max; n += 1) {
    let ok = true;
    for (let m = n; m <= n + 10 && ok; m += 1)
      if (signTestPower(m, d, w) < TARGET) ok = false;
    if (ok) return n;
  }
  return null;
}

if (import.meta.main) {
  const rows: Array<{
    discordance: number;
    mars_share: number;
    min_tasks: number | null;
    power_at_min: number | null;
    power_at_10: number;
  }> = [];
  for (const w of [0.7, 0.75, 0.8])
    for (const d of [0.2, 0.3, 0.4]) {
      const n = minimumTasks(d, w);
      rows.push({
        discordance: d,
        mars_share: w,
        min_tasks: n,
        power_at_min:
          n === null ? null : Number(signTestPower(n, d, w).toFixed(3)),
        power_at_10: Number(signTestPower(10, d, w).toFixed(3)),
      });
    }
  if (process.argv.includes("--json"))
    console.log(JSON.stringify(rows, null, 2));
  else {
    console.log(
      `alpha ${ALPHA}, target power ${TARGET}, exact two-sided sign test over tasks`,
    );
    console.log(
      "| MARS share of discordant tasks | Discordant tasks | Minimum tasks (80% power) | Power at minimum | Power with 10 tasks |",
    );
    console.log("| --- | --- | --- | --- | --- |");
    for (const r of rows)
      console.log(
        `| ${r.mars_share * 100}/${Math.round((1 - r.mars_share) * 100)} | ${r.discordance * 100}% | ${r.min_tasks} | ${r.power_at_min} | ${r.power_at_10} |`,
      );
  }
}
