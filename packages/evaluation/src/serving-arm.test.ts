import { expect, test } from "bun:test";
import { sha256 } from "@mars/contracts/canonical";
import { startFakeVllm } from "../../providers-vllm/src/index";
import { createServingArmEvaluator, servingSeed } from "./serving-arm";
import type { ArmEvaluationInput } from "./specialist-comparison";

const input = (): ArmEvaluationInput => ({
  job_id: "job",
  subject: {
    specialist_id: "s",
    revision: "1",
    candidate_sha256: "a".repeat(64),
  },
  target: {
    arm: "base",
    model: { component: "base", revision: "1" },
    specialist_revision: null,
    adapter: null,
  },
  base_model: { component: "base", revision: "1" },
  tasks: [
    {
      task_id: "task",
      domain: "coding/edit",
      role: "worker",
      complexity: "medium",
      request: "question",
    },
  ],
  repeats: 1,
  seed: "seed",
  budget: {
    max_tokens: 10,
    max_usd: 0,
    max_duration_ms: 1000,
    max_depth: 1,
    max_concurrency: 1,
  },
  signal: new AbortController().signal,
});

test("serving arms resolve model and prompts, bound tokens and measure calls", async () => {
  const bodies: Record<string, unknown>[] = [];
  const evaluator = createServingArmEvaluator({
    baseUrl: "http://127.0.0.1:1/v1",
    apiKeyEnv: "KEY",
    env: {},
    baseServedModel: "base",
    evaluator_id: "eval",
    evaluator_revision: "1",
    harness: { component: "harness", revision: "1" },
    suite: { suite_id: "suite", revision: "1" },
    maxTokensPerRequest: 100,
    promptOptimizedSystemPrompt: "optimized",
    grade: () => 1,
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        choices: [{ message: { content: "answer" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    },
  });
  for (const arm of [
    "base",
    "prompt_optimized_baseline",
    "candidate",
    "current_specialist",
  ] as const) {
    const request = input();
    request.target.arm = arm;
    request.target.adapter = {
      artifact_id: "adapter",
      sha256: "b".repeat(64),
      byte_length: 1,
      media_type: "application/octet-stream",
    };
    const result = await evaluator.evaluate(request);
    expect(result.model_requests).toBe(1);
    expect(result.outcomes[0]).toMatchObject({
      rewards: [1],
      input_tokens: 1,
      output_tokens: 1,
      cost_usd: 0,
    });
    expect(bodies.at(-1)).toMatchObject({
      model:
        arm === "base" || arm === "prompt_optimized_baseline"
          ? "base"
          : "b".repeat(64),
      temperature: 0,
      max_tokens: 10,
    });
  }
  expect(JSON.stringify(bodies[1])).toContain("optimized");
  expect(evaluator.simulated).toBe(false);
  const empty = input();
  empty.tasks = [];
  expect((await evaluator.evaluate(empty)).model_requests).toBe(0);
  const exhausted = input();
  exhausted.budget.max_tokens = 0;
  await expect(evaluator.evaluate(exhausted)).rejects.toThrow(
    "budget_exhausted",
  );
  const cancelled = input();
  cancelled.signal = AbortSignal.abort();
  await expect(evaluator.evaluate(cancelled)).rejects.toThrow();
});

test("specialist arms without adapter hashes refuse before any counted request or fake completion", async () => {
  let completions = 0;
  let countedRequests = 0;
  const server = startFakeVllm({
    completions: () => {
      completions++;
      return "answer";
    },
  });
  try {
    const evaluator = createServingArmEvaluator({
      baseUrl: `${server.url}/v1`,
      apiKeyEnv: "KEY",
      env: {},
      baseServedModel: "mars-base",
      evaluator_id: "eval",
      evaluator_revision: "1",
      harness: { component: "h", revision: "1" },
      suite: { suite_id: "s", revision: "1" },
      grade: () => 1,
      fetch: (url, init) => {
        countedRequests++;
        return fetch(url, init);
      },
    });
    for (const arm of ["candidate", "current_specialist"] as const) {
      for (const adapter of [
        null,
        {
          artifact_id: "adapter",
          sha256: "",
          byte_length: 0,
          media_type: "application/octet-stream",
        },
      ]) {
        const request = input();
        request.target = { ...request.target, arm, adapter };
        await expect(evaluator.evaluate(request)).rejects.toThrow(
          "adapter_missing",
        );
        expect(countedRequests).toBe(0);
        expect(completions).toBe(0);
        expect(server.modelRequests()).toHaveLength(0);
        expect(server.requests).toHaveLength(0);
      }
    }
  } finally {
    await server.stop();
  }
});

test("serving evaluator rejects malformed responses and missing usage, invalid grades and token overruns", async () => {
  for (const mode of ["malformed", "usage", "grade", "budget"] as const) {
    const evaluator = createServingArmEvaluator({
      baseUrl: "http://127.0.0.1:1/v1",
      apiKeyEnv: "KEY",
      env: {},
      baseServedModel: "base",
      evaluator_id: "eval",
      evaluator_revision: "1",
      harness: { component: "h", revision: "1" },
      suite: { suite_id: "s", revision: "1" },
      grade: () => (mode === "grade" ? 2 : 1),
      fetch: async () =>
        Response.json(
          mode === "malformed"
            ? {}
            : {
                choices: [{ message: { content: "answer" } }],
                ...(mode !== "usage"
                  ? {
                      usage: {
                        prompt_tokens: mode === "budget" ? 11 : 1,
                        completion_tokens: 1,
                      },
                    }
                  : {}),
              },
        ),
    });
    await expect(evaluator.evaluate(input())).rejects.toThrow();
  }
});

test("serving seed uses decimal safe integers and otherwise hashes the job seed", () => {
  expect(servingSeed("0")).toBe(0);
  expect(servingSeed("12345")).toBe(12345);
  expect(servingSeed(String(Number.MAX_SAFE_INTEGER))).toBe(
    Number.MAX_SAFE_INTEGER,
  );
  for (const seed of ["9007199254740992", "-1", "1.5", "seed", ""]) {
    expect(servingSeed(seed)).toBe(
      Number.parseInt(sha256(seed).slice(0, 8), 16),
    );
  }
  expect(Number.isSafeInteger(servingSeed("a1b2c3d4e5f60718"))).toBe(true);
});

test("every arm of one job forwards the same matched seed to vLLM and different jobs differ", async () => {
  let completions = 0;
  const server = startFakeVllm({
    completions: () => {
      completions++;
      return "answer";
    },
  });
  try {
    const evaluator = createServingArmEvaluator({
      baseUrl: `${server.url}/v1`,
      apiKeyEnv: "KEY",
      env: {},
      baseServedModel: "mars-base",
      evaluator_id: "eval",
      evaluator_revision: "1",
      harness: { component: "h", revision: "1" },
      suite: { suite_id: "s", revision: "1" },
      promptOptimizedSystemPrompt: "optimized",
      grade: () => 1,
    });
    const arms = [
      "base",
      "prompt_optimized_baseline",
      "current_specialist",
      "candidate",
    ] as const;
    const runJob = async (jobSeed: string) => {
      const manifests: string[] = [];
      for (const arm of arms) {
        const request = input();
        request.seed = jobSeed;
        request.repeats = 2;
        request.target = {
          ...request.target,
          arm,
          adapter: {
            artifact_id: "adapter",
            sha256: (arm === "candidate" ? "c" : "d").repeat(64),
            byte_length: 1,
            media_type: "application/octet-stream",
          },
        };
        const result = await evaluator.evaluate(request);
        expect(result.model_requests).toBe(2);
        manifests.push(result.agent_manifest_sha256);
      }
      return manifests;
    };
    const first = await runJob("a1b2c3d4e5f60718");
    const second = await runJob("1f2e3d4c5b6a7980");
    const bodies = server
      .modelRequests()
      .map((request) => request.body as Record<string, unknown>);
    expect(completions).toBe(16);
    expect(bodies).toHaveLength(16);
    for (const body of bodies) expect(body.temperature).toBe(0);
    const firstSeeds = new Set(bodies.slice(0, 8).map((body) => body.seed));
    const secondSeeds = new Set(bodies.slice(8).map((body) => body.seed));
    expect([...firstSeeds]).toEqual([servingSeed("a1b2c3d4e5f60718")]);
    expect([...secondSeeds]).toEqual([servingSeed("1f2e3d4c5b6a7980")]);
    expect(servingSeed("a1b2c3d4e5f60718")).not.toBe(
      servingSeed("1f2e3d4c5b6a7980"),
    );
    expect(new Set(bodies.map((body) => body.model))).toEqual(
      new Set(["mars-base", "c".repeat(64), "d".repeat(64)]),
    );
    for (let arm = 0; arm < arms.length; arm++)
      expect(first[arm]).not.toBe(second[arm]);
  } finally {
    await server.stop();
  }
});
