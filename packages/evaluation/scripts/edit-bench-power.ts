/**
 * Prints the exact power table quoted in documentation/EVALUATION.md.
 *
 *   bun packages/evaluation/scripts/edit-bench-power.ts [--json]
 */
import {
  MIN_POWERED_TASKS,
  minimumPoweredTasks,
  POWER_DESIGN,
  signTestPower,
} from "../src/edit-benchmark/power";

const rows = [];
for (const share of [0.7, 0.75, 0.8])
  for (const discordance of [0.2, 0.3, 0.4]) {
    const n = minimumPoweredTasks(discordance, share);
    rows.push({
      share,
      discordance,
      min_tasks: n,
      power_at_min: n === null ? null : signTestPower(n, discordance, share),
      power_at_10: signTestPower(10, discordance, share),
    });
  }
if (process.argv.includes("--json")) console.log(JSON.stringify(rows, null, 2));
else {
  console.log(
    `Exact two-sided sign test over tasks, alpha ${POWER_DESIGN.alpha}, target power ${POWER_DESIGN.target}; minimum = smallest N with power >= target for N..N+10.`,
  );
  console.log(
    "| MARS share of discordant tasks | Tasks discordant | Minimum tasks | Power at minimum | Power with 10 tasks |",
  );
  console.log("| --- | --- | --- | --- | --- |");
  for (const r of rows)
    console.log(
      `| ${Math.round(r.share * 100)}/${Math.round((1 - r.share) * 100)} | ${Math.round(r.discordance * 100)}% | ${r.min_tasks} | ${r.power_at_min?.toFixed(3)} | ${r.power_at_10.toFixed(3)} |`,
    );
  console.log(
    `\nPre-registered design point: ${Math.round(POWER_DESIGN.share * 100)}/${Math.round((1 - POWER_DESIGN.share) * 100)} share, ${Math.round(POWER_DESIGN.discordance * 100)}% discordant -> MIN_POWERED_TASKS = ${MIN_POWERED_TASKS}.`,
  );
}
