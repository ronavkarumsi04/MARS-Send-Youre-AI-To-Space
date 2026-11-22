import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EDIT_BENCHMARK_SUITE_V1_DIR } from "@mars/evaluation";
import { loadEditFormatEvidence, runBench } from "./bench";

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});
const noNetwork = async () => {
  throw new Error("no network in tests");
};

test("bench refuses without an explicit mode, a live budget cap or a live model", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-bench-cli-"));
  roots.push(root);
  const out = join(root, "out");
  const progress: string[] = [];
  const run = (args: string[]) =>
    runBench(["edit-formats", ...args], () => undefined, {
      env: {},
      fetch: noNetwork,
      err: (line) => progress.push(line),
    });
  await expect(run(["--out", out])).rejects.toThrow("mode_required");
  await expect(run(["--live", "--offline", "--out", out])).rejects.toThrow(
    "mode_required",
  );
  await expect(
    run(["--live", "--model", "ollama/qwen3-coder", "--out", out]),
  ).rejects.toThrow("budget_cap_required");
  await expect(run(["--live", "--max-usd", "1", "--out", out])).rejects.toThrow(
    "model_required",
  );
  await expect(
    run(["--live", "--model", "nowhere/model", "--max-usd", "1", "--out", out]),
  ).rejects.toThrow("model_unavailable");
  await expect(
    run([
      "--offline",
      "--out",
      out,
      "--signing-key-env",
      "MISSING_KEY",
      "--signing-key-id",
      "k",
    ]),
  ).rejects.toThrow("signing_key_missing");
  expect(progress).toEqual([]);
});

test("bench --offline runs the scripted benchmark and its report loads as serve evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-bench-cli-"));
  roots.push(root);
  const out = join(root, "out");
  const lines: string[] = [];
  const progress: string[] = [];
  await runBench(
    [
      "edit-formats",
      "--offline",
      "--profile",
      "patch-fluent",
      "--suite",
      EDIT_BENCHMARK_SUITE_V1_DIR,
      "--arms",
      "mars:apply_patch,omp-stock",
      "--repeats",
      "1",
      "--out",
      out,
      "--repository",
      "repo",
      "--signing-key-env",
      "BENCH_KEY",
      "--signing-key-id",
      "bench",
    ],
    (line) => lines.push(line),
    {
      env: { BENCH_KEY: "not-a-real-secret" },
      fetch: noNetwork,
      err: (line) => progress.push(line),
    },
  );
  const summary = JSON.parse(lines.join("\n"));
  expect(summary).toMatchObject({
    status: "completed",
    simulated: true,
    signed: true,
    trials: 20,
    provider_requests: 0,
    // v1 has 10 tasks, below the power minimum: exploratory, no verdict.
    bar_met: false,
    exploratory: true,
  });
  expect(summary.scripted_model_requests).toBeGreaterThan(0);
  expect(summary.model_requests).toBeUndefined();
  expect(progress[0]).toContain("20 scripted trials (provider requests: 0)");
  expect(progress).toContain("Offline benchmark: 1/20 trials completed.");
  expect(progress.at(-1)).toBe("Offline benchmark: 20/20 trials completed.");
  expect(await readFile(join(out, "report.md"), "utf8")).toContain("SIMULATED");
  const evidence = await loadEditFormatEvidence(out, {
    key_id: "bench",
    secret: new TextEncoder().encode("not-a-real-secret"),
  });
  expect(evidence).toHaveLength(1);
  expect(evidence[0]).toMatchObject({
    repository: "repo",
    simulated: true,
    report_sha256: summary.report_sha256,
  });
}, 120_000);

test("bench defaults to the v2 suite and all four arms", async () => {
  const run = runBench(
    [
      "edit-formats",
      "--offline",
      "--out",
      join(tmpdir(), "mars-bench-cli-unused"),
      "--max-usd",
      "1",
      "--max-usd-per-task",
      "1",
    ],
    () => undefined,
    { env: {}, fetch: noNetwork },
  );
  // 144 v2 tasks x 3 repeats x 4 arms, refused before any trial runs.
  await expect(run).rejects.toThrow("1728 trials");
});
