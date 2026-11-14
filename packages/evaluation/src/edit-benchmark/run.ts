import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, sha256 } from "@mars/contracts/canonical";
import type { TrainingLineageView } from "@mars/datasets";
import {
  EXECUTION_PACKAGE_VERSION,
  selectExecutionModel,
} from "@mars/execution";
import type { ModelProviderRegistry } from "@mars/providers";
import { servingSeed } from "../serving-arm";
import {
  type EditBenchmarkArm,
  OMP_STOCK_ARM,
  OMP_STOCK_TOOLS,
  runEditTrial,
  type TrialBudget,
  type TrialResult,
} from "./arms";
import {
  bestMarsArm,
  type EditBenchmarkReport,
  judgeBar,
  PREREGISTERED_BAR,
  pairedComparison,
  renderEditBenchmarkMarkdown,
  sealReport,
  summarizeArm,
} from "./report";
import { assertHeldOut, type EditBenchmarkSuite } from "./tasks";

export const EDIT_BENCHMARK_SEED_SCHEMA = "mars.edit-benchmark-seed/v1";

export interface EditBenchmarkRunOptions {
  suite: EditBenchmarkSuite;
  arms: readonly EditBenchmarkArm[];
  registry: ModelProviderRegistry;
  modelId: string;
  env?: Record<string, string | undefined>;
  /** Model transport, captured before trials disable process-wide network access. */
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  repeats: number;
  budgetPerTask: TrialBudget;
  /** Hard aggregate cap: refused up front unless trials × per-task USD fits. */
  maxTotalUsd: number;
  /** Optional aggregate token cap, enforced the same way. */
  maxTotalTokens?: number;
  /** Repository the evidence is about; selection only uses matching reports. */
  repository: string;
  outDir: string;
  /** True for scripted fake models; recorded in the report and never decides selection. */
  simulated: boolean;
  lineages?: readonly TrainingLineageView[];
  signer?: { key_id: string; secret: Uint8Array };
  seedSalt?: string;
  now?: () => Date;
  onTrial?: (result: TrialResult) => void;
}

export interface EditBenchmarkRun {
  report: EditBenchmarkReport;
  markdown: string;
  trials: TrialResult[];
  files: {
    report: string;
    markdown: string;
    trials: string;
    transcripts: string;
  };
}

/**
 * Runs every task × repeat in every arm under one matched seed, model and
 * per-task budget, then writes `report.json` (sealed: sha256, HMAC when a
 * signer is given), `report.md`, `trials.jsonl` and raw transcripts.
 */
export async function runEditBenchmark(
  options: EditBenchmarkRunOptions,
): Promise<EditBenchmarkRun> {
  if (!Number.isInteger(options.repeats) || options.repeats < 1)
    throw new Error("repeats must be a positive integer.");
  if (options.arms.length === 0) throw new Error("No benchmark arms.");
  if (new Set(options.arms).size !== options.arms.length)
    throw new Error("Benchmark arms must be distinct.");
  if (!options.arms.includes(OMP_STOCK_ARM))
    throw new Error("The omp-stock baseline arm is required.");
  if (!options.arms.some((arm) => arm !== OMP_STOCK_ARM))
    throw new Error("At least one mars:<format> arm is required.");
  assertHeldOut(options.suite, options.lineages ?? []);
  const model = selectExecutionModel(options.registry, options.modelId, true);
  const trialsPlanned =
    options.suite.tasks.length * options.repeats * options.arms.length;
  const worstUsd = trialsPlanned * options.budgetPerTask.max_usd;
  if (worstUsd > options.maxTotalUsd + 1e-12)
    throw new Error(
      `budget_cap_too_low: ${trialsPlanned} trials × $${options.budgetPerTask.max_usd} per task exceeds the $${options.maxTotalUsd} cap.`,
    );
  if (
    options.maxTotalTokens !== undefined &&
    trialsPlanned * options.budgetPerTask.max_tokens > options.maxTotalTokens
  )
    throw new Error(
      `budget_cap_too_low: ${trialsPlanned} trials × ${options.budgetPerTask.max_tokens} tokens per task exceeds the ${options.maxTotalTokens} token cap.`,
    );
  const jobSeed = sha256(
    canonicalJson([
      EDIT_BENCHMARK_SEED_SCHEMA,
      options.seedSalt ?? "",
      options.suite.sha256,
      options.modelId,
      options.repeats,
    ]),
  );
  const transcripts = join(options.outDir, "transcripts");
  const workRoot = join(options.outDir, "work");
  await mkdir(transcripts, { recursive: true, mode: 0o700 });
  const trials: TrialResult[] = [];
  for (const task of options.suite.tasks)
    for (let repeat = 0; repeat < options.repeats; repeat += 1) {
      // Every arm of a (task, repeat) pair sees the same forwarded seed.
      const seed = servingSeed(
        sha256(canonicalJson([jobSeed, task.task_id, repeat])),
      );
      for (const arm of options.arms) {
        const result = await runEditTrial({
          arm,
          task,
          repeat,
          registry: options.registry,
          modelId: options.modelId,
          seed,
          budget: options.budgetPerTask,
          fetch: options.fetch,
          ...(options.env ? { env: options.env } : {}),
          workRoot,
          transcriptRoot: transcripts,
        });
        trials.push(result);
        options.onTrial?.(result);
      }
    }
  const arms = options.arms.map((arm) => summarizeArm(arm, trials, jobSeed));
  const best = bestMarsArm(arms);
  const paired = best ? pairedComparison(best.arm, trials) : null;
  const verdict = judgeBar(
    best,
    arms.find((arm) => arm.arm === OMP_STOCK_ARM),
    paired,
  );
  const limitations = [
    ...(options.simulated
      ? [
          "SIMULATED: scripted fake models drove both arms; this report tests the pipeline, statistics and report only and says nothing about any real model.",
        ]
      : []),
    `Every arm ran the same ${options.suite.tasks.length} task(s), ${options.repeats} repeat(s), model ${options.modelId}, forwarded seed per (task, repeat) and per-task budget.`,
    `omp-stock runs Oh My Pi's own built-in tools (${OMP_STOCK_TOOLS.join(", ")}) with its default, model-resolved edit mode in a throwaway copy; MARS arms use only mars_* tools. Neither arm may run commands, and process-wide fetch is disabled during trials except the injected model transport.`,
    "Verification is host-side: the throwaway workspace must equal the expected tree byte for byte.",
    "Paired analysis counts a task as solved when a strict majority of its repeats solved.",
    "Seeds are forwarded to OpenAI-compatible endpoints; providers apply them best effort.",
  ];
  const unsigned = {
    generated_at: (options.now?.() ?? new Date()).toISOString(),
    simulated: options.simulated,
    repository: options.repository,
    harness: {
      mars_execution: EXECUTION_PACKAGE_VERSION,
      omp_stock_tools: [...OMP_STOCK_TOOLS],
    },
    model: {
      id: model.id,
      provider_id: model.providerId,
      free: model.pricing.free,
      input_per_mtok_usd: model.pricing.inputPerMTokUsd ?? null,
      output_per_mtok_usd: model.pricing.outputPerMTokUsd ?? null,
    },
    seed: { job: jobSeed, serving: servingSeed(jobSeed) },
    suite: {
      suite_id: options.suite.suite_id,
      revision: options.suite.revision,
      sha256: options.suite.sha256,
      tasks: options.suite.tasks.length,
      heldout_split_id: options.suite.split.split_id,
      heldout_split_sha256: options.suite.split.sha256,
      lineages_checked: options.lineages?.length ?? 0,
      provenance: options.suite.provenance,
    },
    repeats: options.repeats,
    budget_per_task: options.budgetPerTask,
    budget_total: {
      max_usd: options.maxTotalUsd,
      max_tokens: options.maxTotalTokens ?? null,
    },
    preregistered_bar: PREREGISTERED_BAR,
    arms,
    paired,
    verdict,
    trials: trials.map(({ verification, ...rest }) => ({
      ...rest,
      verification: {
        missing: verification.missing,
        unexpected: verification.unexpected,
        mismatched: verification.mismatched,
      },
    })),
    limitations,
  };
  const report = sealReport(unsigned, options.signer);
  const markdown = renderEditBenchmarkMarkdown(report);
  const files = {
    report: join(options.outDir, "report.json"),
    markdown: join(options.outDir, "report.md"),
    trials: join(options.outDir, "trials.jsonl"),
    transcripts,
  };
  await writeFile(files.report, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(files.markdown, markdown);
  await writeFile(
    files.trials,
    `${trials.map((trial) => JSON.stringify(trial)).join("\n")}\n`,
  );
  return { report, markdown, trials, files };
}
