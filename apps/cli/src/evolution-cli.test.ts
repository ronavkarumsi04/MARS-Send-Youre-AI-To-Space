import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import {
  createFixtureEvaluator,
  createModelProposer,
  createProcessSandbox,
  DEFAULT_EVOLUTION_DOCKER_IMAGE,
  EvolutionService,
  type EvolutionServiceOptions,
  runOfflineDemo,
} from "@mars/evolution";
import { loadModelRegistry, ModelRouter } from "@mars/providers";
import {
  createFixture,
  optionalEvolutionDockerSandbox,
  replaceLine,
  runConfig,
} from "../../../packages/evolution/src/test-support";
import {
  createLiveSmokeEvaluator,
  createSmokeProposerClient,
  EvolutionUsageError,
  rollbackSmokePromotion,
  runEvolution,
  seedLiveSmokeBase,
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
  const first = createLiveSmokeEvaluator("image-one");
  expect(first.appliedComponents).toEqual([]);
  expect(createLiveSmokeEvaluator("image-one").digest).toBe(first.digest);
  expect(createLiveSmokeEvaluator("image-two").digest).not.toBe(first.digest);
});

test.each([
  [
    "forged stdout and stderr",
    `console.log('"hello world"'); console.error('"hello world"'); return 'wrong';`,
  ],
  [
    "forged result file",
    `try { Bun.write('/workspace/result.json', '"hello world"'); } catch {} return 'wrong';`,
  ],
  [
    "early exit",
    `console.log('"hello world"'); process.exit(0); return 'wrong';`,
  ],
  ["coercible object", `return { toJSON() { return 'hello world'; } };`],
])(
  "live-smoke rejects %s instead of a correct return value",
  async (_case, body) => {
    const fixture = await createFixture(() => ({ hypothesis: "unused" }));
    roots.push(fixture.root);
    await writeFile(
      join(fixture.baseDir, "harness", "solver.mjs"),
      `export function solve() { ${body} }\n`,
    );
    await writeFile(
      join(fixture.baseDir, "harness", "result.json"),
      '"hello world"',
    );
    const evaluator = createLiveSmokeEvaluator("test-image");
    const service = await fixture.open({ evaluator });
    try {
      await fixture.start(
        service,
        runConfig({
          selection: { stages: [{ tasks: ["sel-trim-collapse"] }], repeats: 1 },
        }),
      );
      await service.run("run-1");
      expect(
        service.lineage("run-1").find((row) => row.candidate_id === "initial")
          ?.score,
      ).toBe(0);
    } finally {
      service.close();
    }
  },
);

async function checkBundledLiveSmokeScores(
  sandbox: EvolutionServiceOptions["sandbox"],
  image: string,
): Promise<void> {
  const baseline =
    "export function solve(_task, input) { return input.trim(); }";
  const fixed = `export { normalize as solve } from './normalize.mjs';`;
  const forged = `export function solve() { console.log('"hello world"'); return 'wrong'; }`;
  const fixture = await createFixture(({ child_index }) => ({
    hypothesis:
      child_index === 0 ? "Normalize input" : "Change the solver output",
    patch: replaceLine(
      "harness/solver.mjs",
      baseline,
      child_index === 0 ? fixed : forged,
    ),
  }));
  roots.push(fixture.root);
  await seedLiveSmokeBase(fixture.baseDir);
  await writeFile(
    join(fixture.baseDir, "harness", "solver.mjs"),
    `${baseline}\n`,
  );
  await writeFile(
    join(fixture.baseDir, "harness", "normalize.mjs"),
    String.raw`export function normalize(task, input) { return task.includes('slug') ? input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : input.trim().replace(/\s+/g, ' '); }`,
  );
  const service = await fixture.open({
    evaluator: createLiveSmokeEvaluator(image),
    sandbox,
  });
  try {
    await fixture.start(
      service,
      runConfig({
        children_per_generation: 2,
        selection: { stages: [{ tasks: ["sel-trim-collapse"] }], repeats: 1 },
        final_test: {
          tasks: ["final-mixed-spaces", "final-punct-slug"],
          repeats: 2,
        },
        regression_families: [],
      }),
    );
    await service.run("run-1");
    const candidates = service.lineage("run-1");
    expect(
      candidates.find((row) => row.candidate_id === "g1-c0"),
    ).toMatchObject({ state: "evaluated", score: 1 });
    expect(
      candidates.find((row) => row.candidate_id === "g1-c1"),
    ).toMatchObject({ state: "evaluated", score: 0 });
    const decision = await service.promote({
      run_id: "run-1",
      idempotency_key: "promote",
    });
    expect(decision.verdict).toBe("accepted");
  } finally {
    service.close();
  }
}

test("live-smoke credits a legitimate solver patch on selection and held-out tasks after the production Bun build", async () => {
  const sandbox = createProcessSandbox({
    path: [
      dirname(process.execPath),
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ].join(delimiter),
  });
  await checkBundledLiveSmokeScores(sandbox, "test-image");
});

const smokeDockerSandbox = await optionalEvolutionDockerSandbox();

test.skipIf(!smokeDockerSandbox)(
  "live-smoke scores legitimate and forged solver bundles built in Docker",
  async () => {
    if (!smokeDockerSandbox) throw new Error("Docker sandbox was not verified");
    await checkBundledLiveSmokeScores(
      smokeDockerSandbox,
      DEFAULT_EVOLUTION_DOCKER_IMAGE,
    );
  },
  30_000,
);

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

test("a named smoke run resumes in its legacy scope and requires its original model", async () => {
  const fixture = await createFixture(({ generation }) => ({
    hypothesis: `Refine the prompt in generation ${generation}`,
    prompts: { system: `Updated prompt ${generation}` },
  }));
  roots.push(fixture.root);
  const service = await fixture.open();
  try {
    const args = [
      "live-smoke",
      "--state",
      fixture.root,
      "--run",
      "legacy",
      "--generations",
      "2",
    ];
    const modelArgs = ["--model", "example/legacy:free"];
    const results: boolean[] = [];
    const smoke: NonNullable<Parameters<typeof runEvolution>[1]> = async ({
      scopeKey,
      model,
      runId,
      generations,
    }) => {
      const result = await service.startRun({
        config: runConfig({ run_id: runId, generations }),
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
      results.push(result.created);
      const execution = await service.run(
        runId,
        result.created ? { maxGenerations: 1 } : undefined,
      );
      expect(execution).toEqual({
        status: result.created ? "running" : "completed",
        generations_completed: result.created ? 1 : generations,
      });
      return result;
    };
    await runEvolution([...args, ...modelArgs, "--scope", "live-smoke"], smoke);
    expect(service.status("legacy").status).toBe("running");
    expect(fixture.contexts.map(({ generation }) => generation)).toEqual([1]);
    await runEvolution([...args, ...modelArgs], smoke);
    expect(results).toEqual([true, false]);
    expect(service.status("legacy").scope_key).toBe("live-smoke");
    expect(service.status("legacy").status).toBe("completed");
    expect(fixture.contexts.map(({ generation }) => generation)).toEqual([
      1, 2,
    ]);
    expect(await service.verify("legacy")).toMatchObject({
      ok: true,
      problems: [],
    });
    await expect(
      runEvolution([...args, ...modelArgs, "--scope", "wrong"], smoke),
    ).rejects.toThrow("exists with a different config");
    await expect(
      runEvolution([...args, "--model", "example/other:free"], smoke),
    ).rejects.toThrow("uses model example/legacy:free, not example/other:free");
    expect(results).toEqual([true, false]);
  } finally {
    service.close();
  }
});
