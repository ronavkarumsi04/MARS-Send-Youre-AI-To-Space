import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DockerSandboxPrerequisiteError,
  DockerSandboxRootUserError,
} from "@mars/workspaces";
import {
  type CandidateEvaluator,
  createFixtureEvaluator,
  type EvaluationRequest,
} from "./evaluators";
import { createScriptedProposer, type ProposalContext } from "./proposers";
import {
  createEvolutionDockerSandbox,
  createProcessSandbox,
  type EvolutionDockerSandboxOptions,
} from "./sandbox";
import type { MutationProposal, RunConfigInput } from "./schemas";
import {
  EvolutionService,
  type EvolutionServiceOptions,
  type StartRunInput,
} from "./service";

export const BASE_POLICY = '{"default":0.3,"effort":1}';
export const BETTER_POLICY = '{"default":0.9,"effort":1}';
export const HIDDEN_ANSWER = "SECRET-ANSWER-f1-do-not-train";

export async function optionalEvolutionDockerSandbox(
  options?: EvolutionDockerSandboxOptions,
): Promise<EvolutionServiceOptions["sandbox"] | null> {
  let sandbox: EvolutionServiceOptions["sandbox"];
  try {
    sandbox = createEvolutionDockerSandbox(options);
  } catch (error) {
    if (error instanceof DockerSandboxRootUserError) return null;
    throw error;
  }
  try {
    await sandbox.verify();
    return sandbox;
  } catch (error) {
    if (error instanceof DockerSandboxPrerequisiteError) return null;
    throw error;
  }
}

export function replaceLine(
  path: string,
  before: string,
  after: string,
): string {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${before}\n+${after}\n`;
}

export function addFile(path: string, line: string, mode = "100644"): string {
  return `diff --git a/${path} b/${path}\nnew file mode ${mode}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+${line}\n`;
}

export function policyPatch(policy: string): string {
  return replaceLine("harness/fixture-policy.json", BASE_POLICY, policy);
}

export function runConfig(
  overrides: Partial<RunConfigInput> = {},
): RunConfigInput {
  return {
    schema: "mars.evolution-run/v1",
    run_id: "run-1",
    seed: "seed-1",
    generations: 1,
    children_per_generation: 1,
    selection: {
      stages: [{ tasks: ["s1", "s2", "s3"] }, { tasks: ["s4"] }],
      repeats: 2,
    },
    final_test: {
      tasks: ["f1", "f2", "f3", "f4"],
      repeats: 4,
      bootstrap_samples: 500,
    },
    regression_families: [
      { family: "other", tasks: ["r1", "r2"], tolerance: 0.1 },
    ],
    evaluation_budget: {
      max_tokens: 1000,
      max_usd: 1,
      max_duration_ms: 60_000,
      max_depth: 0,
      max_concurrency: 1,
    },
    budget: {
      max_tokens: 1_000_000,
      max_usd: 100,
      max_duration_ms: 3_600_000,
      max_depth: 10,
      max_concurrency: 1,
    },
    harness: {
      mutable_paths: ["harness/**"],
      protected_paths: [
        "evaluator/**",
        "permissions/**",
        "accounting/**",
        "build.sh",
      ],
      build: {
        argv: ["/bin/sh", "build.sh"],
        timeout_ms: 30_000,
        bundle_dir: "dist",
      },
    },
    ...overrides,
  };
}

export interface Fixture {
  root: string;
  storeDir: string;
  workDir: string;
  baseDir: string;
  controlFile: string;
  hiddenFile: string;
  requests: EvaluationRequest[];
  contexts: ProposalContext[];
  open(options?: {
    evaluator?: CandidateEvaluator;
    sandbox?: EvolutionServiceOptions["sandbox"];
    holder?: string;
    leaseTtlMs?: number;
    propose?: (context: ProposalContext) => MutationProposal;
  }): Promise<EvolutionService>;
  start(service: EvolutionService, config?: RunConfigInput): Promise<void>;
}

/** Offline fixture: fake evaluator, scripted proposer, host-process builds. No model requests. */
export async function createFixture(
  propose: (context: ProposalContext) => MutationProposal,
  rootDir?: string,
): Promise<Fixture> {
  const root = rootDir ?? (await mkdtemp(join(tmpdir(), "mars-evolution-")));
  const baseDir = join(root, "base");
  const controlDir = join(root, "control");
  for (const dir of ["harness", "evaluator", "permissions", "accounting"])
    await mkdir(join(baseDir, dir), { recursive: true });
  await mkdir(join(controlDir, "hidden"), { recursive: true });
  await writeFile(
    join(baseDir, "harness", "fixture-policy.json"),
    `${BASE_POLICY}\n`,
  );
  await writeFile(join(baseDir, "harness", "agent.txt"), "prompt-v1\n");
  await writeFile(
    join(baseDir, "evaluator", "score.ts"),
    "export const score = 1;\n",
  );
  await writeFile(
    join(baseDir, "permissions", "policy.json"),
    '{"allow":[]}\n',
  );
  await writeFile(join(baseDir, "accounting", "ledger.json"), "[]\n");
  await writeFile(
    join(baseDir, "build.sh"),
    "set -e\nrm -rf dist\nmkdir dist\ncp harness/* dist/\nif [ -f harness/hook.sh ]; then sh harness/hook.sh; fi\n",
  );
  await chmod(join(baseDir, "build.sh"), 0o755);
  const controlFile = join(controlDir, "evaluator.json");
  await writeFile(controlFile, '{"evaluator":"fixture"}\n');
  const hiddenFile = join(controlDir, "hidden", "answers.txt");
  await writeFile(hiddenFile, `${HIDDEN_ANSWER}\n`);
  const requests: EvaluationRequest[] = [];
  const contexts: ProposalContext[] = [];
  const fixture: Fixture = {
    root,
    storeDir: join(root, "store"),
    workDir: join(root, "work"),
    baseDir,
    controlFile,
    hiddenFile,
    requests,
    contexts,
    async open(options = {}) {
      const evaluator = options.evaluator ?? createFixtureEvaluator();
      const recording: CandidateEvaluator = {
        digest: evaluator.digest,
        simulated: evaluator.simulated,
        ...(evaluator.appliedComponents
          ? { appliedComponents: evaluator.appliedComponents }
          : {}),
        evaluate(request, signal) {
          requests.push(request);
          return evaluator.evaluate(request, signal);
        },
      };
      return EvolutionService.open({
        storeDir: fixture.storeDir,
        workDir: fixture.workDir,
        evaluator: recording,
        proposer: createScriptedProposer("scripted", (context) => {
          contexts.push(context);
          return (options.propose ?? propose)(context);
        }),
        sandbox: options.sandbox ?? createProcessSandbox(),
        protectedControlPaths: [controlFile],
        hiddenAnswerPaths: [join(controlDir, "hidden")],
        ...(options.holder ? { holder: options.holder } : {}),
        ...(options.leaseTtlMs ? { leaseTtlMs: options.leaseTtlMs } : {}),
      });
    },
    async start(service, config = runConfig()) {
      const input: StartRunInput = {
        config,
        scope_key: "scope-1",
        base_dir: baseDir,
        base_ref: "fixture@v1",
        model: { id: "fake-model", provider: "fake", revision: "2026-11-01" },
        prompts: { system: "You are MARS." },
        skills: { store_revision: "skills-r1" },
        tools: [
          { name: "bash", revision: "1" },
          { name: "edit", revision: "1" },
        ],
        retrieval: {
          repo_map_tokens: 2048,
          memory_top_k: 8,
          context_window_tokens: 32_000,
          research: false,
        },
      };
      await service.startRun(input);
    },
  };
  return fixture;
}
