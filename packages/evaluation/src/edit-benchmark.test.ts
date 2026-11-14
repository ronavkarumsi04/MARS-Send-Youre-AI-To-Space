import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectEditFormat } from "@mars/execution";
import {
  bootstrapRatio,
  createScriptedEditModel,
  EDIT_BENCHMARK_SUITE_V1_DIR,
  EDIT_TASK_CATEGORIES,
  editBenchmarkArms,
  editFormatEvidenceFromReport,
  exactSignTest,
  loadEditBenchmarkSuite,
  parseEditBenchmarkArm,
  runEditBenchmark,
  SCRIPTED_PROFILES,
  scriptedModelRegistry,
  verifyEditBenchmarkReport,
  wilsonInterval,
} from "./index";

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});
const scratch = async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-edit-bench-"));
  roots.push(root);
  return root;
};
const suite = await loadEditBenchmarkSuite(EDIT_BENCHMARK_SUITE_V1_DIR);
const budget = { max_tokens: 400_000, max_usd: 1, max_duration_ms: 60_000 };

async function offlineRun(
  profile: string,
  options: {
    repeats?: number;
    tasks?: number;
    signer?: { key_id: string; secret: Uint8Array };
  } = {},
) {
  const root = await scratch();
  const { registry, env, modelId } = await scriptedModelRegistry(root);
  const picked = {
    ...suite,
    tasks: suite.tasks.slice(0, options.tasks ?? suite.tasks.length),
  };
  const model = createScriptedEditModel({
    tasks: suite.tasks,
    profile: SCRIPTED_PROFILES[profile] as (typeof SCRIPTED_PROFILES)[string],
  });
  const repeats = options.repeats ?? 1;
  const run = await runEditBenchmark({
    suite: picked,
    arms: editBenchmarkArms(),
    registry,
    env,
    modelId,
    fetch: model.fetch,
    repeats,
    budgetPerTask: budget,
    maxTotalUsd: picked.tasks.length * repeats * 2,
    repository: "mars-repo",
    outDir: join(root, "out"),
    simulated: true,
    ...(options.signer ? { signer: options.signer } : {}),
    now: () => new Date("2026-11-14T12:00:00.000Z"),
  });
  return { run, model, root };
}

test("the curated suite loads as a held-out split covering every category with provenance", () => {
  expect(suite.tasks).toHaveLength(10);
  expect(new Set(suite.tasks.map((task) => task.category))).toEqual(
    new Set(EDIT_TASK_CATEGORIES),
  );
  expect(suite.split.schema).toBe("mars.held-out-split/v1");
  expect(suite.split.tasks.map((task) => task.request)).toEqual(
    suite.tasks.map((task) => task.instruction),
  );
  for (const task of suite.tasks)
    expect(task.provenance.origin).toBe("authored");
  expect(suite.sha256).toMatch(/^[a-f0-9]{64}$/);
});

test("statistics: exact sign test, Wilson interval and seeded bootstrap", () => {
  expect(exactSignTest(10, 0).p_two_sided).toBeCloseTo(2 / 1024, 12);
  expect(exactSignTest(5, 5).p_two_sided).toBe(1);
  expect(exactSignTest(0, 0).p_two_sided).toBe(1);
  expect(exactSignTest(8, 2).p_two_sided).toBeCloseTo(0.109375, 9);
  const w = wilsonInterval(7, 10);
  expect(w.lower).toBeGreaterThan(0.39);
  expect(w.upper).toBeLessThan(0.9);
  const units = [
    { numerator: 3, denominator: 1 },
    { numerator: 5, denominator: 1 },
    { numerator: 4, denominator: 0 },
  ];
  const a = bootstrapRatio(units, { seed: "s" });
  expect(a).toEqual(bootstrapRatio(units, { seed: "s" }));
  expect(a.estimate).toBe(6);
  expect(a.low as number).toBeLessThanOrEqual(6);
  expect(a.high as number).toBeGreaterThanOrEqual(6);
  expect(
    bootstrapRatio([{ numerator: 1, denominator: 0 }], { seed: "s" }).estimate,
  ).toBeNull();
});

test("arms derive from the MARS format table plus omp-stock", () => {
  expect(editBenchmarkArms()).toEqual(["mars:apply_patch", "omp-stock"]);
  expect(parseEditBenchmarkArm("omp-stock")).toBe("omp-stock");
  expect(() => parseEditBenchmarkArm("mars:sed")).toThrow("Unknown arm");
});

test("offline end to end: scripted small model, both arms, sealed report, transcripts, zero real calls", async () => {
  const signer = {
    key_id: "bench",
    secret: new TextEncoder().encode("bench-secret-not-real"),
  };
  const { run, model } = await offlineRun("small-model", { signer });
  expect(run.trials).toHaveLength(20);
  expect(model.requests()).toBeGreaterThan(40);
  const arms = run.report.arms as Array<Record<string, unknown>>;
  expect(arms.map((arm) => arm.arm)).toEqual(["mars:apply_patch", "omp-stock"]);
  for (const arm of arms) {
    expect(arm.trials).toBe(10);
    expect(arm).toHaveProperty("solve_rate_wilson95");
    expect(arm).toHaveProperty("edit_failure_rate");
    expect(arm).toHaveProperty("cost_per_verified_solve_usd");
    expect(arm.network_refusals).toBe(0);
  }
  expect(arms[1]?.edit_modes as string[]).toEqual(["hashline"]);
  expect(run.trials.some((trial) => trial.edit_failures > 0)).toBe(true);
  // Every request of both arms for one (task, repeat) carried the same seed.
  for (const task of suite.tasks) {
    const seeds = new Set(
      run.trials.filter((t) => t.task_id === task.task_id).map((t) => t.seed),
    );
    expect(seeds.size).toBe(1);
  }
  expect(model.seeds().every((seed) => Number.isSafeInteger(seed))).toBe(true);
  // Sealed: digest and HMAC verify; any edit breaks them.
  const onDisk = JSON.parse(await readFile(run.files.report, "utf8"));
  expect(verifyEditBenchmarkReport(onDisk, signer).report_sha256).toBe(
    run.report.report_sha256,
  );
  expect(() => verifyEditBenchmarkReport({ ...onDisk, repeats: 9 })).toThrow(
    "report_digest_mismatch",
  );
  expect(() =>
    verifyEditBenchmarkReport(onDisk, {
      ...signer,
      secret: new TextEncoder().encode("other"),
    }),
  ).toThrow("report_signature_invalid");
  expect(run.markdown).toContain("SIMULATED");
  expect(run.markdown).toContain("Pre-registered bar");
  for (const trial of run.trials) {
    expect(trial.transcript).not.toBeNull();
    expect(
      (await stat(join(run.files.transcripts, trial.transcript as string)))
        .size,
    ).toBeGreaterThan(0);
  }
  expect(
    (await readFile(run.files.trials, "utf8")).trim().split("\n"),
  ).toHaveLength(20);
}, 120_000);

test("the pre-registered bar is reported whichever way it goes", async () => {
  const fluent = await offlineRun("patch-fluent");
  expect(fluent.run.report.verdict).toMatchObject({
    candidate: "mars:apply_patch",
    met: true,
    significant: true,
  });
  expect(
    (fluent.run.report.paired as { candidate_only: string[] }).candidate_only,
  ).toHaveLength(10);
  const hostile = await offlineRun("patch-hostile");
  expect(hostile.run.report.verdict).toMatchObject({
    met: false,
    solve_rate_better: false,
  });
  expect(
    (hostile.run.report.paired as { baseline_only: string[] }).baseline_only,
  ).toHaveLength(10);
  const oracle = await offlineRun("oracle", { tasks: 3, repeats: 2 });
  expect(oracle.run.report.verdict).toMatchObject({ met: false });
  expect(
    (oracle.run.report.paired as { both_solved: number }).both_solved,
  ).toBe(3);
}, 180_000);

test("selection evidence comes from a verified report; simulated reports only decide when allowed", async () => {
  const { run } = await offlineRun("patch-fluent", { tasks: 2 });
  const evidence = editFormatEvidenceFromReport(
    verifyEditBenchmarkReport(run.report),
  );
  expect(evidence).toMatchObject({
    model_id: "scripted/small",
    repository: "mars-repo",
    simulated: true,
  });
  expect(evidence.arms.map((arm) => arm.format)).toEqual(["apply_patch"]);
  const input = {
    modelId: "scripted/small",
    repository: "mars-repo",
    evidence: [evidence],
  };
  expect(selectEditFormat(input).source).toBe("static_default");
  expect(selectEditFormat({ ...input, allowSimulated: true })).toMatchObject({
    source: "benchmark",
    format: "apply_patch",
    report_sha256: run.report.report_sha256,
  });
}, 60_000);

test("refusals: missing baseline, budget cap too low, held-out leakage", async () => {
  const root = await scratch();
  const { registry, env, modelId } = await scriptedModelRegistry(root);
  const model = createScriptedEditModel({
    tasks: suite.tasks,
    profile: SCRIPTED_PROFILES.oracle as (typeof SCRIPTED_PROFILES)[string],
  });
  const base = {
    suite,
    registry,
    env,
    modelId,
    fetch: model.fetch,
    repeats: 1,
    budgetPerTask: budget,
    repository: "r",
    outDir: join(root, "out"),
    simulated: true,
  };
  await expect(
    runEditBenchmark({ ...base, arms: ["mars:apply_patch"], maxTotalUsd: 100 }),
  ).rejects.toThrow("omp-stock baseline arm is required");
  await expect(
    runEditBenchmark({ ...base, arms: editBenchmarkArms(), maxTotalUsd: 5 }),
  ).rejects.toThrow("budget_cap_too_low");
  await expect(
    runEditBenchmark({
      ...base,
      arms: editBenchmarkArms(),
      maxTotalUsd: 100,
      lineages: [
        { task_ids: [], requests: [suite.tasks[3]?.instruction as string] },
      ],
    }),
  ).rejects.toThrow("heldout_leakage");
  expect(model.requests()).toBe(0);
});
