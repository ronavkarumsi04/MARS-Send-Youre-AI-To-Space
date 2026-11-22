import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvolutionError } from "./errors";
import { createFixtureEvaluator, FIXTURE_POLICY_FILE } from "./evaluators";
import {
  buildProposalMessages,
  createModelProposer,
  DEFAULT_FREE_PROPOSER_MODEL,
  extractProposalJson,
  isFreeOpenRouterModel,
  type ModelProposerClient,
  type ProposalContext,
} from "./proposers";
import {
  createProcessSandbox,
  DEFAULT_EVOLUTION_DOCKER_IMAGE,
} from "./sandbox";
import { EvolutionService } from "./service";
import {
  createFixture,
  optionalEvolutionDockerSandbox,
  runConfig,
} from "./test-support";

const dockerSandbox = await optionalEvolutionDockerSandbox();

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "mars-evo-m5b-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function seedHarness(baseDir: string): Promise<void> {
  await mkdir(join(baseDir, "harness"), { recursive: true });
  await mkdir(join(baseDir, "protected"), { recursive: true });
  await writeFile(
    join(baseDir, "harness", FIXTURE_POLICY_FILE),
    `${JSON.stringify({ default: 0, effort: 1, solve: {} }, null, 2)}\n`,
  );
  await writeFile(
    join(baseDir, "protected", "secret.txt"),
    "do-not-expose-or-edit\n",
  );
  await writeFile(
    join(baseDir, "build.sh"),
    [
      "#!/bin/sh",
      "set -eu",
      "mkdir -p dist",
      `cp harness/${FIXTURE_POLICY_FILE} dist/${FIXTURE_POLICY_FILE}`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}

test("offline proposer tests load without Docker on PATH", async () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "test",
      import.meta.path,
      "--test-name-pattern",
      "enforces free-tier OpenRouter models by default",
    ],
    { env: { ...process.env, PATH: "" }, stdout: "pipe", stderr: "pipe" },
  );
  const output = new TextDecoder().decode(result.stderr);
  expect(result.exitCode).toBe(0);
  expect(output).toContain("1 pass");
});

test("optional Docker sandbox requires a non-root uid and gid even with a verified image", async () => {
  await withTempDir(async (dir) => {
    const dockerPath = join(dir, "docker");
    await writeFile(
      dockerPath,
      [
        "#!/bin/sh",
        'case "$1" in',
        "  version) echo 29.0.0 ;;",
        `  image) echo '${JSON.stringify([DEFAULT_EVOLUTION_DOCKER_IMAGE])}' ;;`,
        "  *) exit 1 ;;",
        "esac",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    expect(
      await optionalEvolutionDockerSandbox({
        dockerPath,
        user: { uid: 1000, gid: 1000 },
      }),
    ).not.toBeNull();
    expect(
      await optionalEvolutionDockerSandbox({
        dockerPath,
        user: { uid: 0, gid: 1000 },
      }),
    ).toBeNull();
    expect(
      await optionalEvolutionDockerSandbox({
        dockerPath,
        user: { uid: 1000, gid: 0 },
      }),
    ).toBeNull();
  });
});

test("optional Docker sandbox skips when the configured binary is missing", async () => {
  await withTempDir(async (dir) => {
    const dockerPath = join(dir, "docker");
    expect(
      await optionalEvolutionDockerSandbox({
        dockerPath,
        user: { uid: 1000, gid: 1000 },
      }),
    ).toBeNull();
  });
});

describe("model proposer unit tests", () => {
  test("enforces free-tier OpenRouter models by default", () => {
    expect(isFreeOpenRouterModel("openrouter/free")).toBe(true);
    expect(
      isFreeOpenRouterModel("meta-llama/llama-3.3-70b-instruct:free"),
    ).toBe(true);
    expect(isFreeOpenRouterModel("openai/gpt-4o")).toBe(false);
    expect(isFreeOpenRouterModel("anthropic/claude-3.5-sonnet")).toBe(false);

    const noopClient: ModelProposerClient = {
      async complete() {
        return { content: "{}" };
      },
    };
    expect(() =>
      createModelProposer({ client: noopClient, model: "openai/gpt-4o" }),
    ).toThrow(/refuses paid model/);
    expect(() =>
      createModelProposer({ client: noopClient, route: "reasoning" }),
    ).toThrow(/refuses named route/);
    expect(() =>
      createModelProposer({
        client: noopClient,
        route: "reasoning",
        allowPaid: true,
      }),
    ).not.toThrow();
    expect(() =>
      createModelProposer({
        client: noopClient,
        model: "openai/gpt-4o",
        allowPaid: true,
      }),
    ).not.toThrow();
    const defaultProposer = createModelProposer({ client: noopClient });
    expect(defaultProposer.id).toBe(`model:${DEFAULT_FREE_PROPOSER_MODEL}`);
  });

  test("rejects paid response models and cancels in-flight proposals on abort", async () => {
    await withTempDir(async (dir) => {
      const baseContext = {
        run_id: "r1",
        generation: 1,
        child_index: 0,
        parent: {
          candidate_id: "c0",
          manifest: {
            schema: "mars.agent-manifest/v1" as const,
            model: {
              id: "openrouter/free",
              provider: "openrouter",
              revision: "1",
            },
            prompts: { system_prompt: "base" },
            skills: { store_revision: "1" },
            tools: [],
            retrieval: {
              repo_map_tokens: 0,
              memory_top_k: 0,
              context_window_tokens: 8192,
              research: false,
            },
            harness: {
              base: { ref: "base", tree_sha256: "a".repeat(64) },
              patches: [],
              tree_sha256: "a".repeat(64),
            },
          },
          selection_score: 0.25,
          per_task: [{ task_id: "sel-1", mean: 0 }],
        },
        entry: { kind: "task" as const, task_id: "sel-1" },
        harness_dir: dir,
        seed: "seed-1",
      };

      const paidReplyProposer = createModelProposer({
        client: {
          async complete() {
            return {
              content: '{"hypothesis":"sneaky paid"}',
              model: "openai/gpt-4o",
            };
          },
        },
      });
      await expect(
        paidReplyProposer.propose(baseContext, new AbortController().signal),
      ).rejects.toThrow(/received paid model/);

      let receivedSignal: AbortSignal | undefined;
      const slowProposer = createModelProposer({
        client: {
          async complete(_req, _sel, signal) {
            receivedSignal = signal;
            return await new Promise(() => {
              // intentionally never resolves
            });
          },
        },
      });
      const controller = new AbortController();
      const pending = slowProposer.propose(baseContext, controller.signal);
      setTimeout(() => controller.abort(), 20);
      await expect(pending).rejects.toThrow(/proposal aborted/);
      expect(receivedSignal?.aborted).toBe(true);
    });
  });

  test("extractProposalJson handles raw JSON, fenced JSON, and prose-wrapped JSON", () => {
    expect(extractProposalJson('{"hypothesis":"a"}')).toEqual({
      hypothesis: "a",
    });
    expect(extractProposalJson('```json\n{"hypothesis":"b"}\n```')).toEqual({
      hypothesis: "b",
    });
    expect(
      extractProposalJson('Here is the patch:\n{"hypothesis":"c"}\nDone.'),
    ).toEqual({ hypothesis: "c" });
    expect(() => extractProposalJson("")).toThrow(/empty output/);
    expect(() => extractProposalJson("not json at all")).toThrow(
      /valid JSON object/,
    );
  });

  test("buildProposalMessages includes mutable files, archive, lineage, and failure traces while excluding protected files", async () => {
    await withTempDir(async (dir) => {
      await seedHarness(dir);
      const context: ProposalContext = {
        run_id: "run-1",
        generation: 1,
        child_index: 0,
        parent: {
          candidate_id: "c0",
          manifest: {
            schema: "mars.agent-manifest/v1",
            model: {
              id: "openrouter/free",
              provider: "openrouter",
              revision: "1",
            },
            prompts: { system_prompt: "base" },
            skills: { store_revision: "1" },
            tools: [],
            retrieval: {
              repo_map_tokens: 0,
              memory_top_k: 0,
              context_window_tokens: 8192,
              research: false,
            },
            harness: {
              base: { ref: "base", tree_sha256: "a".repeat(64) },
              patches: [],
              tree_sha256: "a".repeat(64),
            },
          },
          selection_score: 0.25,
          per_task: [{ task_id: "sel-1", mean: 0 }],
        },
        entry: { kind: "task", task_id: "sel-1" },
        harness_dir: dir,
        seed: "seed-1",
        archive: [
          {
            candidate_id: "c0",
            parent_id: null,
            generation: 0,
            depth: 0,
            selection_score: 0.25,
            eligible: true,
            unresolved: ["sel-1"],
            unstable: [],
          },
        ],
        lineage: [
          {
            candidate_id: "c0",
            parent_id: null,
            generation: 0,
            depth: 0,
            selection_score: 0.25,
            hypothesis: "initial",
            changed_paths: [],
          },
        ],
        failure_traces: [
          {
            source: "selection_eval",
            candidate_id: "c0",
            stage: "stage-0",
            task_id: "sel-1",
            rewards: [0],
            notes: ["assertion failed on sel-1"],
          },
        ],
        harness_policy: {
          mutable_paths: ["harness/**"],
          protected_paths: ["protected/**", "build.sh"],
          max_patch_bytes: 16_384,
        },
      };
      const { system, user } = await buildProposalMessages(context);
      expect(system).toContain("NEVER touch protected paths");
      expect(user).toContain(`harness/${FIXTURE_POLICY_FILE}`);
      expect(user).toContain("assertion failed on sel-1");
      expect(user).toContain('"selection_score": 0.25');
      expect(user).not.toContain("protected/secret.txt");
      expect(user).not.toContain("do-not-expose-or-edit");

      const capped = 1_800;
      const boundedRequest = await buildProposalMessages(
        {
          ...context,
          applied_components: [],
          archive: Array.from({ length: 1_000 }, () => ({
            candidate_id: "c0",
            parent_id: null,
            generation: 0,
            depth: 0,
            selection_score: 0.25,
            eligible: true,
            unresolved: ["sel-1"],
            unstable: [],
          })),
          failure_traces: [
            {
              source: "rejected_child",
              candidate_id: "rejected",
              notes: ["雪".repeat(1_000)],
            },
            {
              source: "rejected_child",
              candidate_id: "recent",
              notes: ["short rejection"],
            },
          ],
        },
        capped,
      );
      expect(boundedRequest.system).toContain("only applies harness patches");
      const json = boundedRequest.user.slice(boundedRequest.user.indexOf("{"));
      expect(new TextEncoder().encode(json).byteLength).toBeLessThanOrEqual(
        capped,
      );
      expect(JSON.parse(json).archive.length).toBeLessThan(1_000);
      expect(JSON.parse(json).failure_traces).toEqual([
        {
          source: "rejected_child",
          candidate_id: "recent",
          notes: ["short rejection"],
        },
      ]);
      expect(json).toContain(`harness/${FIXTURE_POLICY_FILE}`);
    });
  });

  test("rejects proposed patches touching protected paths", async () => {
    await withTempDir(async (dir) => {
      await seedHarness(dir);
      const protectedPatch = [
        "diff --git a/protected/secret.txt b/protected/secret.txt",
        "--- a/protected/secret.txt",
        "+++ b/protected/secret.txt",
        "@@ -1 +1 @@",
        "-do-not-expose-or-edit",
        "+hacked",
        "",
      ].join("\n");
      const proposer = createModelProposer({
        client: {
          async complete() {
            return {
              content: JSON.stringify({
                hypothesis: "try to edit protected file",
                patch: protectedPatch,
              }),
            };
          },
        },
      });
      await expect(
        proposer.propose(
          {
            run_id: "run-1",
            generation: 1,
            child_index: 0,
            parent: {
              candidate_id: "c0",
              manifest: {
                schema: "mars.agent-manifest/v1",
                model: {
                  id: "openrouter/free",
                  provider: "openrouter",
                  revision: "1",
                },
                prompts: { system_prompt: "base" },
                skills: { store_revision: "1" },
                tools: [],
                retrieval: {
                  repo_map_tokens: 0,
                  memory_top_k: 0,
                  context_window_tokens: 8192,
                  research: false,
                },
                harness: {
                  base: { ref: "base", tree_sha256: "a".repeat(64) },
                  patches: [],
                  tree_sha256: "a".repeat(64),
                },
              },
              selection_score: 0,
              per_task: [],
            },
            entry: { kind: "task", task_id: "sel-1" },
            harness_dir: dir,
            seed: "seed-1",
            harness_policy: {
              mutable_paths: ["harness/**"],
              protected_paths: ["protected/**", "build.sh"],
              max_patch_bytes: 4096,
            },
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow(/protected_path/);
    });
  });
});

describe("EvolutionService with model proposer and Docker --network=none builds", () => {
  test("model proposer receives selection-only archive, lineage, and failure traces and improves candidate through EvolutionService", async () => {
    await withTempDir(async (dir) => {
      const baseDir = join(dir, "base");
      await seedHarness(baseDir);

      const seenPrompts: string[] = [];
      let callCount = 0;
      const client: ModelProposerClient = {
        async complete(request, selection) {
          callCount += 1;
          expect(selection?.model).toBe("openrouter/free");
          const rawUser = request.messages.find(
            (m) => m.role === "user",
          )?.content;
          const userMsg = typeof rawUser === "string" ? rawUser : "";
          seenPrompts.push(userMsg);
          expect(userMsg).not.toContain("final-1");
          expect(userMsg).not.toContain("final-2");
          expect(userMsg).not.toContain("protected/secret.txt");

          const patch = [
            `diff --git a/harness/${FIXTURE_POLICY_FILE} b/harness/${FIXTURE_POLICY_FILE}`,
            `--- a/harness/${FIXTURE_POLICY_FILE}`,
            `+++ b/harness/${FIXTURE_POLICY_FILE}`,
            "@@ -1,5 +1,5 @@",
            " {",
            '-  "default": 0,',
            '+  "default": 1,',
            '   "effort": 1,',
            '   "solve": {}',
            " }",
            "",
          ].join("\n");
          return {
            content: JSON.stringify({
              hypothesis:
                "raise default solve probability in fixture-policy.json",
              patch,
              prompts: { system_prompt: "improved prompt" },
            }),
            model: "openrouter/free",
          };
        },
      };

      const service = await EvolutionService.open({
        storeDir: join(dir, "store"),
        workDir: join(dir, "work"),
        evaluator: createFixtureEvaluator({ usdPerTrialPerEffort: 0 }),
        proposer: createModelProposer({ client }),
        sandbox: createProcessSandbox(),
      });
      try {
        await service.startRun({
          config: {
            schema: "mars.evolution-run/v1",
            run_id: "model-ctx-run",
            seed: "seed-ctx",
            generations: 1,
            children_per_generation: 1,
            selection: { stages: [{ tasks: ["sel-1", "sel-2"] }], repeats: 1 },
            final_test: { tasks: ["final-1", "final-2"], repeats: 2 },
            evaluation_budget: {
              max_usd: 0,
              max_tokens: 100_000,
              max_duration_ms: 60_000,
              max_depth: 2,
              max_concurrency: 1,
            },
            budget: {
              max_usd: 0,
              max_tokens: 500_000,
              max_duration_ms: 120_000,
              max_depth: 4,
              max_concurrency: 1,
            },
            harness: {
              mutable_paths: ["harness/**"],
              protected_paths: ["protected/**", "build.sh"],
              build: {
                argv: ["/bin/sh", "build.sh"],
                timeout_ms: 30_000,
                bundle_dir: "dist",
              },
            },
          },
          scope_key: "model-ctx-scope",
          base_dir: baseDir,
          base_ref: "base",
          model: {
            id: "openrouter/free",
            provider: "openrouter",
            revision: "1",
          },
          prompts: { system_prompt: "baseline" },
          skills: { store_revision: "1" },
          tools: [],
          retrieval: {
            repo_map_tokens: 0,
            memory_top_k: 0,
            context_window_tokens: 8192,
            research: false,
          },
        });
        const status = await service.run("model-ctx-run");
        expect(status.status).toBe("completed");
        expect(callCount).toBe(1);
        expect(seenPrompts[0]).toContain("archive");
        expect(seenPrompts[0]).toContain("lineage");
        expect(seenPrompts[0]).toContain("failure_traces");
        expect(seenPrompts[0]).toContain("sel-1");
        const verify = await service.verify("model-ctx-run");
        expect(verify.ok).toBe(true);
      } finally {
        service.close();
      }
    });
  });

  test("createModelProposer attaches measured usage to the ledger and enforces run budget", async () => {
    await withTempDir(async (dir) => {
      const baseDir = join(dir, "base");
      await seedHarness(baseDir);
      const client: ModelProposerClient = {
        async complete() {
          return {
            content: JSON.stringify({
              hypothesis: "improve policy while testing usage accounting",
              // Spoofed usage in model output must be ignored in favor of client usage
              usage: { tokens: 0, usd: 0, ms: 0 },
              patch: [
                `diff --git a/harness/${FIXTURE_POLICY_FILE} b/harness/${FIXTURE_POLICY_FILE}`,
                `--- a/harness/${FIXTURE_POLICY_FILE}`,
                `+++ b/harness/${FIXTURE_POLICY_FILE}`,
                "@@ -1,5 +1,5 @@",
                " {",
                '-  "default": 0,',
                '+  "default": 1,',
                '   "effort": 1,',
                '   "solve": {}',
                " }",
                "",
              ].join("\n"),
            }),
            model: "openrouter/free",
            usage: {
              inputTokens: 120,
              outputTokens: 30,
              totalTokens: 150,
              costUsd: 0,
            },
          };
        },
      };

      const service = await EvolutionService.open({
        storeDir: join(dir, "store"),
        workDir: join(dir, "work"),
        evaluator: createFixtureEvaluator({ usdPerTrialPerEffort: 0 }),
        proposer: createModelProposer({ client }),
        sandbox: createProcessSandbox(),
      });
      try {
        await service.startRun({
          config: {
            schema: "mars.evolution-run/v1",
            run_id: "proposal-usage-run",
            seed: "proposal-usage-seed",
            generations: 1,
            children_per_generation: 1,
            selection: { stages: [{ tasks: ["sel-1"] }], repeats: 1 },
            final_test: {
              tasks: ["fin-1", "fin-2"],
              repeats: 2,
              bootstrap_samples: 200,
              max_uses: 1,
            },
            regression_families: [],
            budget: {
              max_tokens: 100_000,
              max_usd: 0,
              max_duration_ms: 120_000,
              max_depth: 2,
              max_concurrency: 1,
            },
            evaluation_budget: {
              max_tokens: 10_000,
              max_usd: 0,
              max_duration_ms: 30_000,
              max_depth: 2,
              max_concurrency: 1,
            },
            harness: {
              mutable_paths: ["harness/**"],
              protected_paths: ["build.sh"],
              max_patch_bytes: 16_384,
              build: {
                argv: ["/bin/sh", "build.sh"],
                timeout_ms: 30_000,
                bundle_dir: "dist",
              },
            },
          },
          scope_key: "proposal-usage-scope",
          base_dir: baseDir,
          base_ref: "base",
          model: {
            id: "openrouter/free",
            provider: "openrouter",
            revision: "1",
          },
          prompts: { system_prompt: "baseline" },
          skills: { store_revision: "1" },
          tools: [],
          retrieval: {
            repo_map_tokens: 0,
            memory_top_k: 0,
            context_window_tokens: 8192,
            research: false,
          },
        });
        const status = await service.run("proposal-usage-run");
        expect(status.status).toBe("completed");
        const proposalRows = service.store
          .ledger("proposal-usage-run")
          .filter((row) => row.key.endsWith("/proposal"));
        expect(proposalRows.length).toBe(2);
        expect(proposalRows.find((row) => row.kind === "settle")?.tokens).toBe(
          150,
        );
        const metrics = service.metrics("proposal-usage-run");
        expect(metrics.search_process.spend.tokens).toBeGreaterThanOrEqual(150);
        const verify = await service.verify("proposal-usage-run");
        expect(verify.ok).toBe(true);
      } finally {
        service.close();
      }
    });
  });

  test("proposal usage exceeding run budget halts the run with budget_exhausted", async () => {
    await withTempDir(async (dir) => {
      const baseDir = join(dir, "base");
      await seedHarness(baseDir);
      const client: ModelProposerClient = {
        async complete() {
          return {
            content: JSON.stringify({
              hypothesis: "expensive proposal that exceeds max_tokens",
              patch: [
                `diff --git a/harness/${FIXTURE_POLICY_FILE} b/harness/${FIXTURE_POLICY_FILE}`,
                `--- a/harness/${FIXTURE_POLICY_FILE}`,
                `+++ b/harness/${FIXTURE_POLICY_FILE}`,
                "@@ -1,5 +1,5 @@",
                " {",
                '-  "default": 0,',
                '+  "default": 1,',
                '   "effort": 1,',
                '   "solve": {}',
                " }",
                "",
              ].join("\n"),
            }),
            model: "openrouter/free",
            usage: {
              inputTokens: 5000,
              outputTokens: 1000,
              totalTokens: 6000,
              costUsd: 0,
            },
          };
        },
      };

      const service = await EvolutionService.open({
        storeDir: join(dir, "store"),
        workDir: join(dir, "work"),
        evaluator: createFixtureEvaluator({ usdPerTrialPerEffort: 0 }),
        proposer: createModelProposer({ client }),
        sandbox: createProcessSandbox(),
      });
      try {
        await service.startRun({
          config: {
            schema: "mars.evolution-run/v1",
            run_id: "proposal-budget-exhausted-run",
            seed: "proposal-budget-seed",
            generations: 1,
            children_per_generation: 1,
            selection: { stages: [{ tasks: ["sel-1"] }], repeats: 1 },
            final_test: {
              tasks: ["fin-1", "fin-2"],
              repeats: 2,
              bootstrap_samples: 200,
              max_uses: 1,
            },
            regression_families: [],
            budget: {
              max_tokens: 5000,
              max_usd: 0,
              max_duration_ms: 120_000,
              max_depth: 2,
              max_concurrency: 1,
            },
            evaluation_budget: {
              max_tokens: 100,
              max_usd: 0,
              max_duration_ms: 30_000,
              max_depth: 2,
              max_concurrency: 1,
            },
            harness: {
              mutable_paths: ["harness/**"],
              protected_paths: ["build.sh"],
              max_patch_bytes: 16_384,
              build: {
                argv: ["/bin/sh", "build.sh"],
                timeout_ms: 30_000,
                bundle_dir: "dist",
              },
            },
          },
          scope_key: "proposal-budget-scope",
          base_dir: baseDir,
          base_ref: "base",
          model: {
            id: "openrouter/free",
            provider: "openrouter",
            revision: "1",
          },
          prompts: { system_prompt: "baseline" },
          skills: { store_revision: "1" },
          tools: [],
          retrieval: {
            repo_map_tokens: 0,
            memory_top_k: 0,
            context_window_tokens: 8192,
            research: false,
          },
        });
        const status = await service.run("proposal-budget-exhausted-run");
        expect(status.status).toBe("budget_exhausted");
        const metrics = service.metrics("proposal-budget-exhausted-run");
        expect(metrics.search_process.spend.tokens).toBeGreaterThanOrEqual(
          6000,
        );
        const verify = await service.verify("proposal-budget-exhausted-run");
        expect(verify.ok).toBe(true);
      } finally {
        service.close();
      }
    });
  });

  test("charges malformed and policy-invalid proposals until the run budget stops further calls", async () => {
    await withTempDir(async (dir) => {
      const runId = "rejected-proposal-budget-run";
      const baseDir = join(dir, "base");
      await seedHarness(baseDir);
      const protectedPatch = [
        "diff --git a/protected/secret.txt b/protected/secret.txt",
        "--- a/protected/secret.txt",
        "+++ b/protected/secret.txt",
        "@@ -1 +1 @@",
        "-do-not-expose-or-edit",
        "+replacement",
        "",
      ].join("\n");
      let calls = 0;
      const client: ModelProposerClient = {
        async complete() {
          calls += 1;
          return {
            content:
              calls === 1
                ? '{"hypothesis":'
                : JSON.stringify({
                    hypothesis: "edit a protected path",
                    patch: protectedPatch,
                  }),
            model: "openrouter/free",
            usage: { inputTokens: 4500, outputTokens: 1500, costUsd: 0.01 },
          };
        },
      };
      const service = await EvolutionService.open({
        storeDir: join(dir, "store"),
        workDir: join(dir, "work"),
        evaluator: createFixtureEvaluator({ usdPerTrialPerEffort: 0 }),
        proposer: createModelProposer({ client }),
        sandbox: createProcessSandbox(),
      });
      try {
        await service.startRun({
          config: {
            schema: "mars.evolution-run/v1",
            run_id: runId,
            seed: "rejected-proposal-budget-seed",
            generations: 1,
            children_per_generation: 3,
            selection: { stages: [{ tasks: ["sel-1"] }], repeats: 1 },
            final_test: {
              tasks: ["fin-1", "fin-2"],
              repeats: 2,
              bootstrap_samples: 200,
              max_uses: 1,
            },
            regression_families: [],
            budget: {
              max_tokens: 12000,
              max_usd: 1,
              max_duration_ms: 120_000,
              max_depth: 2,
              max_concurrency: 1,
            },
            evaluation_budget: {
              max_tokens: 100,
              max_usd: 0,
              max_duration_ms: 30_000,
              max_depth: 2,
              max_concurrency: 1,
            },
            harness: {
              mutable_paths: ["harness/**"],
              protected_paths: ["build.sh", "protected/**"],
              max_patch_bytes: 16_384,
              build: {
                argv: ["/bin/sh", "build.sh"],
                timeout_ms: 30_000,
                bundle_dir: "dist",
              },
            },
          },
          scope_key: "rejected-proposal-budget-scope",
          base_dir: baseDir,
          base_ref: "base",
          model: {
            id: "openrouter/free",
            provider: "openrouter",
            revision: "1",
          },
          prompts: { system_prompt: "baseline" },
          skills: { store_revision: "1" },
          tools: [],
          retrieval: {
            repo_map_tokens: 0,
            memory_top_k: 0,
            context_window_tokens: 8192,
            research: false,
          },
        });
        expect((await service.run(runId)).status).toBe("budget_exhausted");
        expect(calls).toBe(2);
        expect(service.store.getCandidate(runId, "g1-c0")).toMatchObject({
          state: "rejected",
          reason: expect.stringContaining("did not return a valid JSON object"),
        });
        expect(service.store.getCandidate(runId, "g1-c1")).toMatchObject({
          state: "rejected",
          reason: expect.stringContaining("protected_path"),
        });
        const settled = service.store
          .ledger(runId)
          .filter(
            (row) => row.kind === "settle" && row.key.endsWith("/proposal"),
          )
          .map(({ key, tokens, usd, ms }) => ({ key, tokens, usd, ms }));
        expect(settled).toEqual([
          {
            key: "g1-c0/proposal",
            tokens: 6000,
            usd: 0.01,
            ms: expect.any(Number),
          },
          {
            key: "g1-c1/proposal",
            tokens: 6000,
            usd: 0.01,
            ms: expect.any(Number),
          },
        ]);
        expect((await service.run(runId)).status).toBe("budget_exhausted");
        expect(calls).toBe(2);
        expect((await service.verify(runId)).ok).toBe(true);
      } finally {
        service.close();
      }
    });
  });

  test("reserves prompt and clamped output before dispatch and keeps the reservation after an interrupted proposal", async () => {
    await withTempDir(async (dir) => {
      const fixture = await createFixture(
        () => ({ hypothesis: "unused" }),
        dir,
      );
      const cfg = runConfig();
      let calls = 0;
      const service = await EvolutionService.open({
        storeDir: fixture.storeDir,
        workDir: fixture.workDir,
        evaluator: createFixtureEvaluator({ usdPerTrialPerEffort: 0 }),
        sandbox: createProcessSandbox(),
        proposer: createModelProposer({
          maxTokens: 20_000,
          client: {
            async complete(request) {
              calls += 1;
              const reserve = service.store
                .ledger("run-1")
                .find(
                  (row) =>
                    row.kind === "reserve" && row.key === "g1-c0/proposal",
                );
              expect(reserve?.tokens).toBe(6_000);
              expect(request.maxTokens).toBeGreaterThan(0);
              expect(request.maxTokens).toBeLessThan(6_000);
              const promptBytes = new TextEncoder().encode(
                JSON.stringify(request.messages),
              ).byteLength;
              expect(
                (request.maxTokens ?? 0) + promptBytes,
              ).toBeLessThanOrEqual(6_000);
              throw new EvolutionError(
                "deadline_exceeded",
                "interrupted before usage arrived",
              );
            },
          },
        }),
      });
      try {
        await fixture.start(service, {
          ...cfg,
          budget: { ...cfg.budget, max_tokens: 6_000 },
        });
        expect((await service.run("run-1")).status).toBe("deadline_exceeded");
        expect(service.store.getCandidate("run-1", "g1-c0")).toBeNull();
        expect((await service.run("run-1")).status).toBe("budget_exhausted");
        expect(calls).toBe(1);
        expect(
          service.store
            .ledger("run-1")
            .filter((row) => row.key.endsWith("/proposal")),
        ).toMatchObject([{ kind: "reserve", tokens: 6_000 }]);
        expect((await service.verify("run-1")).ok).toBe(true);

        await fixture.start(service, {
          ...cfg,
          run_id: "prompt-does-not-fit",
          budget: { ...cfg.budget, max_tokens: 1_000 },
        });
        expect((await service.run("prompt-does-not-fit")).status).toBe(
          "budget_exhausted",
        );
        expect(calls).toBe(1);
      } finally {
        service.close();
      }
    });
  });

  test("caps model cancellation to the remaining wall-clock run deadline", async () => {
    await withTempDir(async (dir) => {
      const fixture = await createFixture(
        () => ({ hypothesis: "unused" }),
        dir,
      );
      const cfg = runConfig();
      const base = createFixtureEvaluator({ usdPerTrialPerEffort: 0 });
      const runDuration = 120_000;
      let clock = 1_000;
      let signalAtProvider: AbortSignal | undefined;
      const service = await EvolutionService.open({
        storeDir: fixture.storeDir,
        workDir: fixture.workDir,
        now: () => clock,
        evaluator: {
          ...base,
          async evaluate(request, signal) {
            const outcome = await base.evaluate(request, signal);
            clock = 1_000 + runDuration - 80;
            return outcome;
          },
        },
        sandbox: createProcessSandbox(),
        proposer: createModelProposer({
          client: {
            async complete(_request, _selection, signal) {
              signalAtProvider = signal;
              return new Promise((_resolve, reject) => {
                signal?.addEventListener("abort", () => reject(signal.reason), {
                  once: true,
                });
              });
            },
          },
        }),
      });
      try {
        await fixture.start(service, {
          ...cfg,
          selection: { stages: [{ tasks: ["s1"] }], repeats: 1 },
          budget: { ...cfg.budget, max_duration_ms: runDuration },
        });
        expect((await service.run("run-1")).status).toBe("deadline_exceeded");
        expect(signalAtProvider?.aborted).toBe(true);
        expect((await service.verify("run-1")).ok).toBe(true);
      } finally {
        service.close();
      }
    });
  }, 2_000);

  test("resumed proposal after crash between ledger settlement and candidate insertion charges retry usage", async () => {
    await withTempDir(async (dir) => {
      const baseDir = join(dir, "base");
      await seedHarness(baseDir);
      const client: ModelProposerClient = {
        async complete() {
          return {
            content: JSON.stringify({
              hypothesis: "retry proposal after simulated crash",
              patch: [
                `diff --git a/harness/${FIXTURE_POLICY_FILE} b/harness/${FIXTURE_POLICY_FILE}`,
                `--- a/harness/${FIXTURE_POLICY_FILE}`,
                `+++ b/harness/${FIXTURE_POLICY_FILE}`,
                "@@ -1,5 +1,5 @@",
                " {",
                '-  "default": 0,',
                '+  "default": 1,',
                '   "effort": 1,',
                '   "solve": {}',
                " }",
                "",
              ].join("\n"),
            }),
            model: "openrouter/free",
            usage: {
              inputTokens: 120,
              outputTokens: 30,
              totalTokens: 150,
              costUsd: 0,
            },
          };
        },
      };

      const service = await EvolutionService.open({
        storeDir: join(dir, "store"),
        workDir: join(dir, "work"),
        evaluator: createFixtureEvaluator({ usdPerTrialPerEffort: 0 }),
        proposer: createModelProposer({ client }),
        sandbox: createProcessSandbox(),
      });
      try {
        await service.startRun({
          config: {
            schema: "mars.evolution-run/v1",
            run_id: "proposal-retry-charge-run",
            seed: "proposal-retry-seed",
            generations: 1,
            children_per_generation: 1,
            selection: { stages: [{ tasks: ["sel-1"] }], repeats: 1 },
            final_test: {
              tasks: ["fin-1", "fin-2"],
              repeats: 2,
              bootstrap_samples: 200,
              max_uses: 1,
            },
            regression_families: [],
            budget: {
              max_tokens: 100_000,
              max_usd: 0,
              max_duration_ms: 120_000,
              max_depth: 2,
              max_concurrency: 1,
            },
            evaluation_budget: {
              max_tokens: 10_000,
              max_usd: 0,
              max_duration_ms: 30_000,
              max_depth: 2,
              max_concurrency: 1,
            },
            harness: {
              mutable_paths: ["harness/**"],
              protected_paths: ["build.sh"],
              max_patch_bytes: 16_384,
              build: {
                argv: ["/bin/sh", "build.sh"],
                timeout_ms: 30_000,
                bundle_dir: "dist",
              },
            },
          },
          scope_key: "proposal-retry-scope",
          base_dir: baseDir,
          base_ref: "base",
          model: {
            id: "openrouter/free",
            provider: "openrouter",
            revision: "1",
          },
          prompts: { system_prompt: "baseline" },
          skills: { store_revision: "1" },
          tools: [],
          retrieval: {
            repo_map_tokens: 0,
            memory_top_k: 0,
            context_window_tokens: 8192,
            research: false,
          },
        });
        // Simulate a crash after proposal ledger settlement but before g1-c0 insertion.
        const at = new Date().toISOString();
        service.store.appendLedger(
          "proposal-retry-charge-run",
          "reserve",
          "g1-c0/proposal",
          { tokens: 100, usd: 0, ms: 50 },
          at,
        );
        service.store.appendLedger(
          "proposal-retry-charge-run",
          "settle",
          "g1-c0/proposal",
          { tokens: 100, usd: 0, ms: 50 },
          at,
        );

        const status = await service.run("proposal-retry-charge-run");
        expect(status.status).toBe("completed");
        const proposalRows = service.store
          .ledger("proposal-retry-charge-run")
          .filter((row) => row.key.startsWith("g1-c0/proposal"));
        expect(proposalRows.length).toBe(4);
        expect(proposalRows.some((row) => row.key === "g1-c0/proposal#1")).toBe(
          true,
        );
        const metrics = service.metrics("proposal-retry-charge-run");
        expect(metrics.search_process.spend.tokens).toBeGreaterThanOrEqual(250);
        const verify = await service.verify("proposal-retry-charge-run");
        expect(verify.ok).toBe(true);
      } finally {
        service.close();
      }
    });
  });

  test.skipIf(!dockerSandbox)(
    "Docker-sandboxed candidate build (--network=none) runs end-to-end with promotion and rollback",
    async () => {
      if (!dockerSandbox) throw new Error("Docker sandbox was not verified");
      await withTempDir(async (dir) => {
        const baseDir = join(dir, "base");
        await seedHarness(baseDir);
        // Verify bun runs inside the pinned Docker container with --network=none
        await writeFile(
          join(baseDir, "build.sh"),
          [
            "#!/bin/sh",
            "set -eu",
            "mkdir -p dist",
            `bun -e 'const fs = require("node:fs"); fs.copyFileSync("harness/${FIXTURE_POLICY_FILE}", "dist/${FIXTURE_POLICY_FILE}");'`,
            "",
          ].join("\n"),
          { mode: 0o755 },
        );

        const client: ModelProposerClient = {
          async complete() {
            return {
              content: JSON.stringify({
                hypothesis: "update fixture-policy.json for docker build test",
                patch: [
                  `diff --git a/harness/${FIXTURE_POLICY_FILE} b/harness/${FIXTURE_POLICY_FILE}`,
                  `--- a/harness/${FIXTURE_POLICY_FILE}`,
                  `+++ b/harness/${FIXTURE_POLICY_FILE}`,
                  "@@ -1,5 +1,5 @@",
                  " {",
                  '-  "default": 0,',
                  '+  "default": 1,',
                  '   "effort": 1,',
                  '   "solve": {}',
                  " }",
                  "",
                ].join("\n"),
              }),
              model: "openrouter/free",
            };
          },
        };

        const service = await EvolutionService.open({
          storeDir: join(dir, "store"),
          workDir: join(dir, "work"),
          evaluator: createFixtureEvaluator({ usdPerTrialPerEffort: 0 }),
          proposer: createModelProposer({ client }),
          sandbox: dockerSandbox,
        });
        try {
          await service.startRun({
            config: {
              schema: "mars.evolution-run/v1",
              run_id: "docker-build-run",
              seed: "seed-docker",
              generations: 1,
              children_per_generation: 1,
              selection: {
                stages: [{ tasks: ["sel-1", "sel-2"] }],
                repeats: 1,
              },
              final_test: {
                tasks: ["final-1", "final-2", "final-3", "final-4"],
                repeats: 2,
              },
              evaluation_budget: {
                max_usd: 0,
                max_tokens: 100_000,
                max_duration_ms: 60_000,
                max_depth: 2,
                max_concurrency: 1,
              },
              budget: {
                max_usd: 0,
                max_tokens: 500_000,
                max_duration_ms: 180_000,
                max_depth: 4,
                max_concurrency: 1,
              },
              harness: {
                mutable_paths: ["harness/**"],
                protected_paths: ["protected/**", "build.sh"],
                build: {
                  argv: ["/bin/sh", "build.sh"],
                  timeout_ms: 60_000,
                  bundle_dir: "dist",
                },
              },
            },
            scope_key: "docker-build-scope",
            base_dir: baseDir,
            base_ref: "base",
            model: {
              id: "openrouter/free",
              provider: "openrouter",
              revision: "1",
            },
            prompts: { system_prompt: "baseline" },
            skills: { store_revision: "1" },
            tools: [],
            retrieval: {
              repo_map_tokens: 0,
              memory_top_k: 0,
              context_window_tokens: 8192,
              research: false,
            },
          });
          const runStatus = await service.run("docker-build-run");
          expect(runStatus.status).toBe("completed");
          const lineage = service.lineage("docker-build-run");
          expect(
            lineage.some(
              (c) => c.state === "evaluated" && c.parent_id !== null,
            ),
          ).toBe(true);
          const decision = await service.promote({
            run_id: "docker-build-run",
            idempotency_key: "promote-docker-build-run",
          });
          expect(decision.verdict).toBe("accepted");
          const rolled = await service.rollback({
            scope_key: "docker-build-scope",
            to_entry_seq: 1,
            expected_pointer_version: 2,
          });
          expect(rolled.entry_seq).toBe(3);
          expect(rolled.manifest_sha256).toBe(
            decision.champion.manifest_sha256,
          );
          const verify = await service.verify("docker-build-run");
          expect(verify.ok).toBe(true);
        } finally {
          service.close();
        }
      });
    },
    60_000,
  );
});
