import { expect, test } from "bun:test";
import { join } from "node:path";

function runHarness(args: string[], env: Record<string, string> = {}) {
  const run = Bun.spawnSync({
    cmd: [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "live-verified-bugfix.ts"),
      ...args,
    ],
    env: { ...process.env, OPENROUTER_API_KEY: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: run.exitCode,
    stdout: run.stdout.toString(),
    stderr: run.stderr.toString(),
  };
}

test("help explains the no-model preflight without requiring credentials", () => {
  const result = runHarness(["--help"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("--preflight");
  expect(result.stdout).toContain("OPENROUTER_API_KEY");
});

test("a missing key stops a live run before Docker is used", () => {
  const result = runHarness(["--image", "not-pinned"], {
    OPENROUTER_API_KEY: " ",
  });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Set OPENROUTER_API_KEY");
  expect(result.stderr).not.toContain("Docker image");
});

test("both modes reject a paid model before Docker is used", () => {
  for (const args of [[], ["--preflight"]]) {
    const result = runHarness([...args, "--model", "openai/gpt-4o"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Refusing non-free OpenRouter model");
  }
});

test("preflight requires a pinned sandbox image but not a model key", () => {
  const result = runHarness(["--preflight", "--image", "oven/bun:latest"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Docker image must be pinned");
  expect(result.stderr).not.toContain("Set OPENROUTER_API_KEY");
});

const image = process.env.MARS_WORKSPACES_BUN_TEST_IMAGE;
test.skipIf(!image)(
  "preflight runs the real Docker baseline without a key",
  () => {
    const result = runHarness(["--preflight", "--image", image ?? ""]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("3 pass");
    expect(result.stdout).toContain("3 fail");
    expect(result.stdout).toContain("model_requests=0");
  },
);
