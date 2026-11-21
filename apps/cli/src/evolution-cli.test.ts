import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProcessSandbox, runOfflineDemo } from "@mars/evolution";
import {
  createFixture,
  runConfig,
} from "../../../packages/evolution/src/test-support";
import {
  createLiveSmokeEvaluator,
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
