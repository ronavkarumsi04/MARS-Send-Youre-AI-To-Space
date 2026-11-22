import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { createEvaluationService, createHarborRunner } from "@mars/evaluation";
import type { SandboxRunner } from "@mars/workspaces";
import {
  context,
  MemoryArtifacts,
  sampleManifest,
} from "../../evaluation/src/test-support";
import { EvolutionError } from "./errors";
import { createFixtureEvaluator, createHarborEvaluator } from "./evaluators";
import { createScriptedProposer } from "./proposers";
import { createProcessSandbox } from "./sandbox";
import { RunConfigSchema } from "./schemas";
import { EvolutionService } from "./service";
import {
  BETTER_POLICY,
  createFixture,
  policyPatch,
  runConfig,
} from "./test-support";
import { snapshotDirectory } from "./tree";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const f = await createFixture(() => ({
    hypothesis: "improve policy",
    patch: policyPatch(BETTER_POLICY),
  }));
  cleanups.push(() => fs.rm(f.root, { recursive: true, force: true }));
  return f;
}

test("hardening 1: oversized snapshot files are rejected before reading", async () => {
  const f = await fixture();
  const dir = join(f.root, "oversized");
  await fs.mkdir(dir);
  const file = join(dir, "large");
  await fs.writeFile(file, "x".repeat(32));
  const read = spyOn(fs, "readFile").mockImplementation(async () => {
    throw new Error("oversized file was read");
  });
  try {
    await expect(
      snapshotDirectory(dir, { maxBytes: 16 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(read).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
  }
});

test("bounded snapshots allow empty trees and exact byte limits", async () => {
  const f = await fixture();
  const dir = join(f.root, "bounded");
  await fs.mkdir(dir);
  expect((await snapshotDirectory(dir, { maxBytes: 0 })).entries).toEqual([]);
  await fs.writeFile(join(dir, "file"), "ok");
  expect((await snapshotDirectory(dir, { maxBytes: 2 })).entries).toHaveLength(
    1,
  );
  await expect(snapshotDirectory(dir, { maxFiles: 0 })).rejects.toMatchObject({
    code: "invalid_input",
  });
});

test("hardening 2: Harbor cancels a job when abort occurs during submission", async () => {
  const f = await fixture();
  await fs.writeFile(join(f.baseDir, "mars-agent"), "fake agent");
  const template = await sampleManifest();
  const controller = new AbortController();
  let cancelled = 0;
  const job = {
    job_id: "cancelled-job",
    input_manifest: {
      artifact_id: "manifest",
      sha256: "a".repeat(64),
      media_type: "application/json",
      byte_length: 0,
    },
  };
  const service = createEvaluationService({
    stateDir: join(f.root, "evaluation"),
    artifacts: new MemoryArtifacts(),
    runner: createHarborRunner({
      pythonPath: "/unused",
      harborPath: "/unused",
      agentPythonPath: f.root,
      jobsDir: join(f.root, "jobs"),
      dockerPath: null,
    }),
  });
  const submit = spyOn(service, "submitComparison").mockImplementation(
    async () => {
      controller.abort();
      return job;
    },
  );
  const cancel = spyOn(service, "cancel").mockImplementation(async () => {
    cancelled += 1;
  });
  const settled = spyOn(service, "settled").mockResolvedValue(undefined);
  const inspect = spyOn(service, "inspect").mockResolvedValue({
    job,
    status: "cancelled",
    artifacts: [],
    cost_usd: null,
  });
  try {
    const evaluator = createHarborEvaluator({
      service,
      context,
      template,
      artifacts: new MemoryArtifacts(),
    });
    const s = await f.open();
    cleanups.push(async () => s.close());
    await f.start(s);
    const champion = s.champion("scope-1");
    if (!champion) throw new Error("missing champion");
    await expect(
      evaluator.evaluate(
        {
          run_id: "run-1",
          subject_id: "initial",
          manifest: {
            ...champion.manifest,
            model: { ...champion.manifest.model, id: template.model.id },
          },
          manifest_sha256: champion.manifest_sha256,
          bundle_dir: f.baseDir,
          bundle_sha256: "a".repeat(64),
          split: "selection",
          family: null,
          tasks: template.tasks,
          repeats: template.repeats,
          seed: "cancel",
          budget: template.budget,
          deadline_ms: Date.now() + 1000,
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "deadline_exceeded" });
    expect(cancelled).toBe(1);
  } finally {
    submit.mockRestore();
    cancel.mockRestore();
    settled.mockRestore();
    inspect.mockRestore();
  }
});

test("hardening 3: ignored evaluator cancellation rejects late results", async () => {
  const f = await fixture();
  const base = createFixtureEvaluator();
  const s = await f.open({
    evaluator: {
      ...base,
      async evaluate(request) {
        await Bun.sleep(80);
        return {
          ...(await base.evaluate(request, new AbortController().signal)),
          runtime_ms: 0,
        };
      },
    },
  });
  cleanups.push(async () => s.close());
  await f.start(
    s,
    runConfig({
      evaluation_budget: {
        max_tokens: 1000,
        max_usd: 1,
        max_duration_ms: 20,
        max_depth: 0,
        max_concurrency: 1,
      },
    }),
  );
  expect((await s.run("run-1")).status).toBe("deadline_exceeded");
  expect(s.store.listSelectionEvaluations("run-1", "initial")).toHaveLength(0);
  await Bun.sleep(100);
});

test.each(["ignored", "cooperative"])(
  "timed-out evaluations require fresh budget on resume (%s cancellation)",
  async (cancellation) => {
    const f = await fixture();
    const base = createFixtureEvaluator();
    let actualSpend = 0;
    const s = await f.open({
      evaluator: {
        ...base,
        async evaluate(request, signal) {
          actualSpend += request.budget.max_usd;
          if (cancellation === "cooperative") {
            await new Promise<never>((_resolve, reject) => {
              const abort = () =>
                reject(new EvolutionError("deadline_exceeded", "aborted"));
              signal.addEventListener("abort", abort, { once: true });
              if (signal.aborted) abort();
            });
          }
          const outcome = await base.evaluate(request, signal);
          await Bun.sleep(80);
          return { ...outcome, cost_usd: request.budget.max_usd };
        },
      },
    });
    cleanups.push(async () => s.close());
    const config = runConfig({
      budget: {
        max_tokens: 1_000_000,
        max_usd: 2,
        max_duration_ms: 3_600_000,
        max_depth: 10,
        max_concurrency: 1,
      },
      evaluation_budget: {
        max_tokens: 1000,
        max_usd: 1,
        max_duration_ms: 20,
        max_depth: 0,
        max_concurrency: 1,
      },
    });
    await f.start(s, config);
    const statuses = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      statuses.push((await s.run("run-1")).status);
      await Bun.sleep(100);
    }
    const reservations = s.store
      .ledger("run-1")
      .filter((row) => row.kind === "reserve");
    const reservedSpend = reservations.reduce((sum, row) => sum + row.usd, 0);
    expect(actualSpend).toBeLessThanOrEqual(config.budget.max_usd);
    expect(reservedSpend).toBe(actualSpend);
    expect(statuses).toEqual([
      "deadline_exceeded",
      "deadline_exceeded",
      "budget_exhausted",
      "budget_exhausted",
    ]);
    expect(s.store.listSelectionEvaluations("run-1", "initial")).toHaveLength(
      0,
    );
    expect(() => s.store.verifyLedger("run-1")).not.toThrow();
  },
);

test("hardening 4: successful process builds terminate background descendants", async () => {
  const f = await fixture();
  const result = await createProcessSandbox({ killGraceMs: 10 }).run({
    workspaceDir: f.baseDir,
    argv: ["/bin/sh", "-c", "sleep 30 >/dev/null 2>&1 & echo $!"],
    timeoutMs: 1000,
    maxOutputBytes: 1024,
    signal: new AbortController().signal,
    runId: "background",
    labels: {},
  });
  const pid = Number(new TextDecoder().decode(result.stdout).trim());
  try {
    let running = true;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const stat = await fs
        .readFile(`/proc/${pid}/stat`, "utf8")
        .catch(() => "");
      running = stat !== "" && !stat.includes(") Z ");
      if (!running) break;
      await Bun.sleep(10);
    }
    expect(result.exitCode).toBe(0);
    expect(running).toBe(false);
  } finally {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
});

test.each(["build", "proposal", "promotion"])(
  "hardening 5: leases survive long %s work",
  async (phase) => {
    const f = await fixture();
    const real = createProcessSandbox();
    let promoting = false;
    let started = false;
    const sandbox: SandboxRunner = {
      ...real,
      async run(request) {
        if (
          (phase === "build" && started) ||
          (phase === "promotion" && promoting)
        )
          await Bun.sleep(650);
        return real.run(request);
      },
    };
    const s = await EvolutionService.open({
      storeDir: f.storeDir,
      workDir: f.workDir,
      evaluator: createFixtureEvaluator(),
      proposer: createScriptedProposer("slow", async () => {
        if (phase === "proposal") await Bun.sleep(650);
        return {
          hypothesis: "improve policy",
          patch: policyPatch(BETTER_POLICY),
        };
      }),
      sandbox,
      leaseTtlMs: 300,
    });
    cleanups.push(async () => s.close());
    await f.start(s);
    started = true;
    expect((await s.run("run-1")).status).toBe("completed");
    promoting = true;
    expect(
      (await s.promote({ run_id: "run-1", idempotency_key: "slow" }))
        .candidate_id,
    ).toBe("g1-c0");
  },
);

test("hardening 6: promotion keys reject different runs and candidates", async () => {
  const f = await fixture();
  const s = await f.open();
  cleanups.push(async () => s.close());
  await f.start(s);
  await s.run("run-1");
  await s.promote({ run_id: "run-1", idempotency_key: "shared" });
  await expect(
    s.promote({
      run_id: "run-1",
      candidate_id: "missing",
      idempotency_key: "shared",
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  await f.start(s, runConfig({ run_id: "run-2" }));
  await expect(
    s.promote({ run_id: "run-2", idempotency_key: "shared" }),
  ).rejects.toMatchObject({ code: "conflict" });
});

test("hardening 7: configuration rejects duplicate final and regression tasks", () => {
  expect(() =>
    RunConfigSchema.parse(
      runConfig({ final_test: { tasks: ["f1", "f1"], repeats: 2 } }),
    ),
  ).toThrow();
  expect(() =>
    RunConfigSchema.parse(
      runConfig({
        regression_families: [{ family: "other", tasks: ["r1", "r1"] }],
      }),
    ),
  ).toThrow();
});
