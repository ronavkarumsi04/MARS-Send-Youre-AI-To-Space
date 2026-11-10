import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvolutionUsageError, runEvolution } from "./evolution";

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
