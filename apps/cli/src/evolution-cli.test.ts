import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFixtureEvaluator,
  createModelProposer,
  createProcessSandbox,
  EvolutionService,
  runOfflineDemo,
} from "@mars/evolution";
import { loadModelRegistry, ModelRouter } from "@mars/providers";
import {
  createFixture,
  runConfig,
} from "../../../packages/evolution/src/test-support";
import {
  createLiveSmokeEvaluator,
  createSmokeProposerClient,
  EvolutionUsageError,
  rollbackSmokePromotion,
  runEvolution,
} from "./evolution";

const entrypoint = join(import.meta.dir, "main.ts");
const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function cli(args: string[]) {
  const child = Bun.spawn(
    [process.execPath, entrypoint, "evolution", ...args],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

test("mars evolution demo runs a FAKE offline lineage and the store supports history/rollback/verify", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-evolution-cli-"));
  roots.push(root);
  const demo = await cli(["demo", "--state", root]);
  expect(demo.code).toBe(0);
  const summary = JSON.parse(demo.stdout);
  expect(summary).toMatchObject({ fake: true, model_requests: 0 });
  expect(summary.decision.verdict).toBe("accepted");
  expect(summary.decision.simulated).toBe(true);
  expect(summary.champion).toBe("g1-c0");
  const history = JSON.parse(
    (await cli(["history", "--state", root, "--scope", "scope-1"])).stdout,
  );
  expect(history.map((entry: { action: string }) => entry.action)).toEqual([
    "initial",
    "deploy",
  ]);
  const champion = JSON.parse(
    (await cli(["champion", "--state", root, "--scope", "scope-1"])).stdout,
  );
  const rolled = await cli([
    "rollback",
    "--state",
    root,
    "--scope",
    "scope-1",
    "--to",
    "1",
    "--expect-version",
    String(champion.pointer_version),
  ]);
  expect(rolled.code).toBe(0);
  expect(
    JSON.parse(
      (await cli(["champion", "--state", root, "--scope", "scope-1"])).stdout,
    ).candidate_id,
  ).toBe("initial");
  const stale = await cli([
    "rollback",
    "--state",
    root,
    "--scope",
    "scope-1",
    "--to",
    "2",
    "--expect-version",
    String(champion.pointer_version),
  ]);
  expect(stale.code).toBe(1);
  expect(stale.stderr).toContain("stale_revision");
  const verify = await cli(["verify", "--state", root, "--run", "demo-run"]);
  expect(verify.code).toBe(0);
  expect(JSON.parse(verify.stdout).ok).toBe(true);
  expect(
    JSON.parse(
      (await cli(["lineage", "--state", root, "--run", "demo-run"])).stdout,
    ),
  ).toHaveLength(3);
}, 60_000);

test("mars evolution rejects missing flags with a usage error", async () => {
  await expect(
    runEvolution(["history", "--state", "/tmp/x"]),
  ).rejects.toBeInstanceOf(EvolutionUsageError);
  await expect(runEvolution([])).rejects.toBeInstanceOf(EvolutionUsageError);
  await expect(
    runEvolution([
      "rollback",
      "--state",
      "/tmp/x",
      "--scope",
      "s",
      "--to=-1",
      "--expect-version",
      "1",
    ]),
  ).rejects.toThrow(/non-negative/);
});

test("live-smoke retries use fresh run IDs after a completed all-rejected run, unless named", async () => {
  const fixture = await createFixture(() => {
    throw new Error("OpenRouter HTTP 429");
  });
  roots.push(fixture.root);
  const service = await fixture.open();
  try {
    const smoke: NonNullable<Parameters<typeof runEvolution>[1]> = async ({
      runId,
    }) => {
      await fixture.start(service, runConfig({ run_id: runId }));
      const status = await service.run(runId);
      expect(status.status).toBe("completed");
      expect(service.lineage(runId)[1]).toMatchObject({
        state: "rejected",
        reason: expect.stringContaining("HTTP 429"),
      });
      return { run_id: runId, ...status };
    };
    const args = ["live-smoke", "--state", fixture.root];
    await runEvolution(args, smoke);
    await runEvolution(args, smoke);
    await runEvolution([...args, "--run", "named"], smoke);
    await runEvolution([...args, "--run", "named"], smoke);
    const requests = fixture.contexts.map((context) => context.run_id);
    expect(requests).toHaveLength(3);
    expect(requests[0]).not.toBe(requests[1]);
    expect(requests[2]).toBe("named");
  } finally {
    service.close();
  }
});

test("live-smoke rolls back a replayed promotion exactly once without changing later champion history", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-evolution-cli-replay-"));
  roots.push(root);
  const { service } = await runOfflineDemo(root);
  try {
    const decision = await service.promote({
      run_id: "demo-run",
      idempotency_key: "demo-promotion",
    });
    expect(decision.verdict).toBe("accepted");
    expect(service.champion("scope-1")?.action).toBe("deploy");
    expect(rollbackSmokePromotion(service, "scope-1", decision)).toBe(true);
    expect(rollbackSmokePromotion(service, "scope-1", decision)).toBe(true);
    expect(service.history("scope-1").map((row) => row.action)).toEqual([
      "initial",
      "deploy",
      "rollback",
    ]);
    const current = service.champion("scope-1");
    if (!current) throw new Error("missing champion");
    service.rollback({
      scope_key: "scope-1",
      to_entry_seq: 2,
      expected_pointer_version: current.pointer_version,
    });
    const later = service.champion("scope-1");
    expect(rollbackSmokePromotion(service, "scope-1", decision)).toBe(true);
    expect(service.champion("scope-1")).toEqual(later);
  } finally {
    service.close();
  }
});

test("live-smoke evaluator identity binds the image and applies only harness patches", () => {
  const sandbox = createProcessSandbox();
  const first = createLiveSmokeEvaluator(sandbox, "image-one");
  expect(first.appliedComponents).toEqual([]);
  expect(createLiveSmokeEvaluator(sandbox, "image-one").digest).toBe(
    first.digest,
  );
  expect(createLiveSmokeEvaluator(sandbox, "image-two").digest).not.toBe(
    first.digest,
  );
});

test("live-smoke settles HTTP 429 and cooldown skips without charging estimated tokens", async () => {
  const fixture = await createFixture(() => ({ hypothesis: "unused" }));
  roots.push(fixture.root);
  const env = { OPENROUTER_API_KEY: "test-openrouter-key" };
  const registry = await loadModelRegistry({
    cwd: fixture.root,
    home: fixture.root,
    env,
    trustProjectConfig: false,
  });
  let networkCalls = 0;
  const router = new ModelRouter(registry, {
    adapterOptions: {
      env,
      fetch: async () => {
        networkCalls += 1;
        return new Response(null, {
          status: 429,
          headers: { "retry-after": "60" },
        });
      },
    },
  });
  const stats = { requests: 0, routedModel: null };
  const service = await EvolutionService.open({
    storeDir: fixture.storeDir,
    workDir: fixture.workDir,
    evaluator: createFixtureEvaluator({ usdPerTrialPerEffort: 0 }),
    sandbox: createProcessSandbox(),
    proposer: createModelProposer({
      client: createSmokeProposerClient(router, stats),
      maxTokens: 20_000,
    }),
  });
  try {
    const config = runConfig();
    await fixture.start(service, {
      ...config,
      budget: { ...config.budget, max_tokens: 6_000 },
      children_per_generation: 3,
    });
    expect((await service.run("run-1")).status).toBe("completed");
    expect(networkCalls).toBe(1);
    expect(stats.requests).toBe(3);
    expect(service.lineage("run-1")[1]?.reason).toContain("HTTP 429");
    expect(service.lineage("run-1")[2]?.reason).toContain("cooling down");
    const entries = service.store
      .ledger("run-1")
      .filter((row) => row.key.endsWith("/proposal"));
    expect(
      entries.filter((row) => row.kind === "reserve").map((row) => row.tokens),
    ).toEqual([6_000, 6_000, 6_000]);
    expect(
      entries
        .filter((row) => row.kind === "settle")
        .map((row) => [row.key, row.tokens, row.usd]),
    ).toEqual([
      ["g1-c0/proposal", 0, 0],
      ["g1-c1/proposal", 0, 0],
      ["g1-c2/proposal", 0, 0],
    ]);
    expect((await service.verify("run-1")).ok).toBe(true);
  } finally {
    service.close();
  }
});

test("live-smoke prints the generated run ID before an interrupted run can return JSON", async () => {
  const stderr = spyOn(console, "error").mockImplementation(() => {});
  const stdout = spyOn(console, "log").mockImplementation(() => {});
  let id = "";
  try {
    await expect(
      runEvolution(
        ["live-smoke", "--state", "/tmp/x"],
        async ({ runId, scopeKey }) => {
          id = runId;
          expect(stderr).toHaveBeenCalledWith(
            `Starting live-smoke run ${runId} (scope ${scopeKey})`,
          );
          throw new Error("interrupted");
        },
      ),
    ).rejects.toThrow("interrupted");
    expect(id).toMatch(/^live-smoke-/);
    expect(stdout).not.toHaveBeenCalled();
  } finally {
    stderr.mockRestore();
    stdout.mockRestore();
  }
});

test("fresh smoke runs with different proposer models can share a state directory", async () => {
  const fixture = await createFixture(() => ({ hypothesis: "unused" }));
  roots.push(fixture.root);
  const service = await fixture.open();
  try {
    const scopes: string[] = [];
    const smoke: NonNullable<Parameters<typeof runEvolution>[1]> = async ({
      state,
      scopeKey,
      model,
      runId,
    }) => {
      expect(state).toBe(fixture.root);
      await service.startRun({
        config: runConfig({ run_id: runId }),
        scope_key: scopeKey,
        base_dir: fixture.baseDir,
        base_ref: "base",
        model: { id: model, provider: "openrouter", revision: "free-tier" },
        prompts: { system: "baseline" },
        skills: { store_revision: "1" },
        tools: [],
        retrieval: {
          repo_map_tokens: 0,
          memory_top_k: 0,
          context_window_tokens: 8192,
          research: false,
        },
      });
      scopes.push(scopeKey);
      expect(service.champion(scopeKey)?.manifest.model.id).toBe(model);
      return { run_id: runId };
    };
    const args = ["live-smoke", "--state", fixture.root];
    await runEvolution(args, smoke);
    await runEvolution([...args, "--model", "example/other:free"], smoke);
    expect(scopes).toHaveLength(2);
    expect(scopes[0]).not.toBe(scopes[1]);
    await expect(
      runEvolution(
        [...args, "--model", "example/other:free", "--scope", "live-smoke"],
        smoke,
      ),
    ).rejects.toThrow("frozen model differs");
  } finally {
    service.close();
  }
});
