import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type CandidateEvaluator,
  createEvolutionDockerSandbox,
  createFixtureEvaluator,
  createModelProposer,
  createProcessSandbox,
  createScriptedProposer,
  DEFAULT_EVOLUTION_DOCKER_IMAGE,
  DEFAULT_FREE_PROPOSER_MODEL,
  digestOf,
  EvolutionError,
  EvolutionService,
  isFreeOpenRouterModel,
  type ModelProposerClient,
  type PromotionDecision,
  ProposalNotGeneratedError,
  runOfflineDemo,
} from "@mars/evolution";
import {
  loadModelRegistry,
  ModelRouter,
  NoModelAvailableError,
} from "@mars/providers";
import { getQuickJS } from "quickjs-emscripten";
import { CliUsageError } from "./cli-errors";

export const EVOLUTION_USAGE = [
  "Usage: mars evolution <command> --state DIR [options]",
  "  demo                                  offline FAKE end-to-end run (no model requests)",
  "  live-smoke [--run ID] [--model ID] [--image REF] live OpenRouter :free proposer + Docker (--network=none) build + held-out gate",
  "  status|lineage|metrics|verify --run ID",
  "  champion|history --scope KEY",
  "  rollback --scope KEY --to SEQ --expect-version N",
].join("\n");

export class EvolutionUsageError extends CliUsageError {}

/** Opens the durable store read-mostly: evaluator/proposer are inert placeholders. */
async function openStore(state: string): Promise<EvolutionService> {
  return EvolutionService.open({
    storeDir: join(state, "store"),
    workDir: join(state, "work"),
    evaluator: createFixtureEvaluator(),
    proposer: createScriptedProposer("cli-readonly", () => {
      throw new EvolutionError(
        "invalid_state",
        "the CLI does not propose mutations",
      );
    }),
    sandbox: createProcessSandbox(),
  });
}

interface SmokeTaskSpec {
  id: string;
  input: string;
  expected: string;
}

const SMOKE_SELECTION_TASKS: readonly SmokeTaskSpec[] = [
  {
    id: "sel-trim-collapse",
    input: "  hello   world  ",
    expected: "hello world",
  },
  {
    id: "sel-slug-normalize",
    input: "Mars_Evolution--v1!",
    expected: "mars-evolution-v1",
  },
];

const SMOKE_FINAL_TASKS: readonly SmokeTaskSpec[] = [
  {
    id: "final-mixed-spaces",
    input: "\talpha\n\n  beta  ",
    expected: "alpha beta",
  },
  {
    id: "final-punct-slug",
    input: "  DGM++ Archive: #5b  ",
    expected: "dgm-archive-5b",
  },
];

const MAX_SMOKE_SOLVER_BYTES = 256 * 1024;

function scoreSmokeSolver(
  vm: Awaited<ReturnType<typeof getQuickJS>>,
  source: string,
  task: SmokeTaskSpec,
  deadline: number,
  signal: AbortSignal,
): boolean {
  using runtime = vm.newRuntime();
  runtime.setMemoryLimit(16 * 1024 * 1024);
  runtime.setMaxStackSize(256 * 1024);
  runtime.setInterruptHandler(
    () => signal.aborted || performance.now() >= deadline,
  );
  using context = runtime.newContext();
  using prelude = context.evalCode(
    "globalThis.console = { log() {}, error() {}, warn() {} };",
    "console.js",
    { type: "global" },
  );
  if (prelude.error) return false;
  using module = context.evalCode(source, "solver.mjs", { type: "module" });
  if (module.error) return false;
  const state = context.getPromiseState(module.value);
  if (state.type === "rejected") {
    state.error.dispose();
    return false;
  }
  if (state.type !== "fulfilled") return false;
  if (!state.notAPromise) {
    state.value.dispose();
    return false;
  }
  using solve = context.getProp(module.value, "solve");
  if (context.typeof(solve) !== "function") return false;
  using taskId = context.newString(task.id);
  using input = context.newString(task.input);
  using result = context.callFunction(solve, context.undefined, taskId, input);
  if (result.error || signal.aborted || performance.now() >= deadline)
    return false;
  using expected = context.newString(task.expected);
  return context.eq(result.value, expected);
}

export function createLiveSmokeEvaluator(image: string): CandidateEvaluator {
  const allTasks = new Map(
    [...SMOKE_SELECTION_TASKS, ...SMOKE_FINAL_TASKS].map((t) => [t.id, t]),
  );
  const digest = digestOf(["mars-evolution-live-smoke-evaluator", "v4", image]);
  return {
    digest,
    simulated: false,
    appliedComponents: [],
    async evaluate(request, signal) {
      const started = performance.now();
      const deadline = started + Math.max(0, request.deadline_ms - Date.now());
      const file = Bun.file(join(request.bundle_dir, "solver.mjs"));
      const source =
        (await file.exists()) && file.size <= MAX_SMOKE_SOLVER_BYTES
          ? await file.text()
          : null;
      const vm = await getQuickJS();
      const per_task: {
        task_id: string;
        rewards: (number | null)[];
        baseline_rewards: (number | null)[] | null;
      }[] = [];
      const notes: string[] = [];
      for (const taskId of request.tasks) {
        const spec = allTasks.get(taskId);
        const rewards: (number | null)[] = [];
        for (let r = 0; r < request.repeats; r += 1) {
          if (signal.aborted) {
            throw new EvolutionError(
              "deadline_exceeded",
              "live smoke evaluation cancelled",
            );
          }
          if (!spec) {
            rewards.push(0);
            continue;
          }
          if (performance.now() >= deadline) {
            throw new EvolutionError(
              "deadline_exceeded",
              "live smoke evaluation deadline exceeded",
            );
          }
          const passed =
            source !== null &&
            scoreSmokeSolver(
              vm,
              source,
              spec,
              Math.min(deadline, performance.now() + 10_000),
              signal,
            );
          if (performance.now() >= deadline || signal.aborted) {
            throw new EvolutionError(
              "deadline_exceeded",
              "live smoke evaluation deadline exceeded or cancelled",
            );
          }
          rewards.push(passed ? 1 : 0);
          if (!passed && request.split === "selection") {
            notes.push(
              `task ${taskId} did not return the expected string: input=${JSON.stringify(spec.input)} expected=${JSON.stringify(spec.expected)}`,
            );
          }
        }
        per_task.push({ task_id: taskId, rewards, baseline_rewards: null });
      }
      return {
        evaluator_digest: digest,
        simulated: false,
        per_task,
        cost_usd: 0,
        tokens: 0,
        runtime_ms: Math.max(1, Math.ceil(performance.now() - started)),
        report: null,
        notes,
      };
    },
  };
}

async function seedLiveSmokeBase(baseDir: string): Promise<void> {
  await mkdir(join(baseDir, "harness"), { recursive: true });
  await mkdir(join(baseDir, "protected"), { recursive: true });
  await writeFile(
    join(baseDir, "harness", "solver.mjs"),
    [
      "export function solve(taskId, input) {",
      "  const text = String(input);",
      "  if (taskId.includes('slug')) {",
      "    // BUG: does not lowercase or collapse punctuation to single hyphens",
      "    return text.trim().replace(/\\s+/g, '-');",
      "  }",
      "  // BUG: only trims, does not collapse internal whitespace",
      "  return text.trim();",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(baseDir, "protected", "policy.txt"),
    "immutable-control-file\n",
  );
  await writeFile(
    join(baseDir, "build.sh"),
    [
      "#!/bin/sh",
      "set -eu",
      "mkdir -p dist",
      "bun build harness/solver.mjs --outfile dist/solver.mjs --target bun >/dev/null",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}

export function rollbackSmokePromotion(
  service: EvolutionService,
  scopeKey: string,
  decision: PromotionDecision,
): boolean {
  if (decision.verdict !== "accepted") return false;
  const history = service.history(scopeKey);
  const deployment = history.find(
    (entry) =>
      entry.action === "deploy" && entry.decision_id === decision.decision_id,
  );
  if (!deployment) return false;
  const target = decision.champion.entry_seq;
  if (
    history.some(
      (entry) =>
        entry.action === "rollback" &&
        entry.seq > deployment.seq &&
        entry.target_seq === target,
    )
  )
    return true;
  const champion = service.champion(scopeKey);
  if (champion?.entry_seq !== deployment.seq) return false;
  service.rollback({
    scope_key: scopeKey,
    to_entry_seq: target,
    expected_pointer_version: champion.pointer_version,
  });
  return true;
}

export function createSmokeProposerClient(
  router: ModelRouter,
  stats: { requests: number; routedModel: string | null },
): ModelProposerClient {
  return {
    async complete(request, selection, signal) {
      stats.requests += 1;
      try {
        const reply = await router.complete(request, selection, signal);
        stats.routedModel = reply.model ?? selection?.model ?? null;
        return reply;
      } catch (error) {
        if (
          error instanceof NoModelAvailableError &&
          error.definitelyNoGeneration
        )
          throw new ProposalNotGeneratedError(error.message, error);
        throw error;
      }
    },
  };
}

async function runLiveSmoke(options: {
  state: string;
  model: string;
  image: string;
  runId: string;
  scopeKey: string;
  generations: number;
  children: number;
}): Promise<Record<string, unknown>> {
  if (!isFreeOpenRouterModel(options.model)) {
    throw new EvolutionUsageError(
      `--model must be "openrouter/free" or end in ":free" (got "${options.model}")`,
    );
  }
  const apiKey =
    process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
  if (!apiKey) {
    throw new EvolutionUsageError(
      "OPENROUTER_API_KEY (or OPENAI_API_KEY holding an OpenRouter key) is required for live-smoke",
    );
  }

  const providerEnv: Record<string, string | undefined> = {
    ...process.env,
    OPENROUTER_API_KEY: apiKey,
  };
  const registry = await loadModelRegistry({
    cwd: options.state,
    env: providerEnv,
    trustProjectConfig: false,
  });
  if (registry.policy.allowPaid) {
    throw new EvolutionError(
      "invalid_input",
      "live-smoke requires allowPaid=false in the model registry",
    );
  }
  const router = new ModelRouter(registry, {
    adapterOptions: { env: providerEnv, timeoutMs: 90_000 },
  });

  const proposerStats = { requests: 0, routedModel: null };
  const instrumentedClient = createSmokeProposerClient(router, proposerStats);

  const baseDir = join(options.state, "base");
  await seedLiveSmokeBase(baseDir);

  const sandbox = createEvolutionDockerSandbox({ image: options.image });
  const open = () =>
    EvolutionService.open({
      storeDir: join(options.state, "store"),
      workDir: join(options.state, "work"),
      evaluator: createLiveSmokeEvaluator(options.image),
      proposer: createModelProposer({
        client: instrumentedClient,
        model: options.model,
        allowPaid: false,
      }),
      sandbox,
    });

  const service = await open();
  try {
    await service.startRun({
      config: {
        schema: "mars.evolution-run/v1",
        run_id: options.runId,
        seed: "live-smoke-v1",
        generations: options.generations,
        children_per_generation: options.children,
        selection: {
          stages: [{ tasks: SMOKE_SELECTION_TASKS.map((t) => t.id) }],
          repeats: 1,
        },
        final_test: {
          tasks: SMOKE_FINAL_TASKS.map((t) => t.id),
          repeats: 2,
        },
        evaluation_budget: {
          max_usd: 0,
          max_tokens: 100_000,
          max_duration_ms: 120_000,
          max_depth: 2,
          max_concurrency: 1,
        },
        budget: {
          max_usd: 0,
          max_tokens: 500_000,
          max_duration_ms: 300_000,
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
      scope_key: options.scopeKey,
      base_dir: baseDir,
      base_ref: "live-smoke-base",
      model: {
        id: options.model,
        provider: "openrouter",
        revision: "free-tier",
      },
      prompts: {
        system_prompt:
          "Normalize whitespace or slugs cleanly in harness/solver.mjs.",
      },
      skills: { store_revision: "live-smoke" },
      tools: [],
      retrieval: {
        repo_map_tokens: 0,
        memory_top_k: 0,
        context_window_tokens: 32_768,
        research: false,
      },
    });
    const status = await service.run(options.runId);
    const lineageBeforePromote = service.lineage(options.runId);
    const hasEvaluatedChild = lineageBeforePromote.some(
      (c) => c.parent_id !== null && c.state === "evaluated",
    );
    const decision = hasEvaluatedChild
      ? await service.promote({
          run_id: options.runId,
          idempotency_key: `${options.runId}-promote`,
        })
      : null;
    const verifyBeforeReopen = await service.verify(options.runId);
    const rolledBack =
      decision !== null &&
      rollbackSmokePromotion(service, options.scopeKey, decision);
    const lineage = service.lineage(options.runId);
    service.close();

    const reopened = await open();
    try {
      const verifyAfterReopen = await reopened.verify(options.runId);
      return {
        schema: "mars.evolution-live-smoke/v1",
        run_id: options.runId,
        scope_key: options.scopeKey,
        proposer_model_requested: options.model,
        proposer_model_routed: proposerStats.routedModel,
        proposer_requests: proposerStats.requests,
        build_isolation: "docker-network-none",
        docker_image: options.image,
        status: status.status,
        candidates: lineage.map((c) => ({
          candidate_id: c.candidate_id,
          parent_id: c.parent_id,
          state: c.state,
          score: c.score,
          reason: c.reason,
        })),
        held_out_gate: decision
          ? {
              verdict: decision.verdict,
              honest_result:
                decision.verdict === "accepted" ? "improved" : "no_improvement",
              simulated: decision.simulated,
              candidate_id: decision.candidate_id,
              quality: decision.quality,
              gates: decision.gates,
              notes: decision.notes,
            }
          : {
              verdict: "no_improvement" as const,
              honest_result: "no_improvement" as const,
              simulated: false,
              candidate_id: null,
              quality: null,
              gates: [],
              notes: [
                "No evaluated child candidate reached the held-out gate; see candidate rejection reasons.",
              ],
            },
        rolled_back: rolledBack,
        verified_before_reopen: verifyBeforeReopen.ok,
        verified_after_reopen: verifyAfterReopen.ok,
        champion_after_reopen:
          reopened.champion(options.scopeKey)?.candidate_id ?? null,
      };
    } finally {
      reopened.close();
    }
  } finally {
    try {
      service.close();
    } catch {
      // already closed
    }
  }
}

export async function runEvolution(
  args: string[],
  smoke = runLiveSmoke,
): Promise<void> {
  const [command, ...rest] = args;
  const { values } = parseArgs({
    args: rest,
    options: {
      state: { type: "string" },
      run: { type: "string" },
      scope: { type: "string" },
      to: { type: "string" },
      "expect-version": { type: "string" },
      model: { type: "string" },
      image: { type: "string" },
      generations: { type: "string" },
      children: { type: "string" },
    },
    strict: true,
  });
  if (!command || !values.state) throw new EvolutionUsageError(EVOLUTION_USAGE);
  const state = isAbsolute(values.state) ? values.state : resolve(values.state);
  if (command === "demo") {
    const { service, summary } = await runOfflineDemo(state);
    service.close();
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  if (command === "live-smoke") {
    const generations = values.generations ? Number(values.generations) : 1;
    const children = values.children ? Number(values.children) : 1;
    if (
      !Number.isSafeInteger(generations) ||
      generations < 1 ||
      !Number.isSafeInteger(children) ||
      children < 1
    ) {
      throw new EvolutionUsageError(
        "--generations and --children must be positive integers",
      );
    }
    const model = values.model ?? DEFAULT_FREE_PROPOSER_MODEL;
    const scopeKey =
      values.scope ??
      (model === DEFAULT_FREE_PROPOSER_MODEL
        ? "live-smoke"
        : `live-smoke-${digestOf(model).slice(0, 16)}`);
    const runId = values.run ?? `live-smoke-${randomUUID()}`;
    if (values.run === undefined)
      console.error(`Starting live-smoke run ${runId} (scope ${scopeKey})`);
    const summary = await smoke({
      state,
      model,
      image: values.image ?? DEFAULT_EVOLUTION_DOCKER_IMAGE,
      runId,
      scopeKey,
      generations,
      children,
    });
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  const need = (value: string | undefined, flag: string) => {
    if (!value)
      throw new EvolutionUsageError(
        `--${flag} is required\n${EVOLUTION_USAGE}`,
      );
    return value;
  };
  const integer = (value: string | undefined, flag: string) => {
    const parsed = Number(need(value, flag));
    if (!Number.isSafeInteger(parsed) || parsed < 0)
      throw new EvolutionUsageError(`--${flag} must be a non-negative integer`);
    return parsed;
  };
  const service = await openStore(state);
  try {
    let output: unknown;
    if (command === "status") output = service.status(need(values.run, "run"));
    else if (command === "lineage")
      output = service.lineage(need(values.run, "run"));
    else if (command === "metrics")
      output = service.metrics(need(values.run, "run"));
    else if (command === "verify")
      output = await service.verify(need(values.run, "run"));
    else if (command === "champion")
      output = service.champion(need(values.scope, "scope"));
    else if (command === "history")
      output = service.history(need(values.scope, "scope"));
    else if (command === "rollback")
      output = service.rollback({
        scope_key: need(values.scope, "scope"),
        to_entry_seq: integer(values.to, "to"),
        expected_pointer_version: integer(
          values["expect-version"],
          "expect-version",
        ),
      });
    else throw new EvolutionUsageError(EVOLUTION_USAGE);
    console.log(JSON.stringify(output, null, 2));
    if (command === "verify" && !(output as { ok: boolean }).ok)
      process.exitCode = 1;
  } finally {
    service.close();
  }
}
