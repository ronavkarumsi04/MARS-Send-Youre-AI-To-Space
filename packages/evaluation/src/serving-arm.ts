import type { ModelConfig, VersionRef } from "@mars/contracts";
import { canonicalJson, sha256 } from "@mars/contracts/canonical";
import { createOpenAICompatibleAdapter } from "@mars/providers";
import type {
  ArmTaskOutcome,
  HeldOutTaskView,
  SpecialistArmEvaluator,
} from "./specialist-comparison";

export interface ServingArmOptions {
  baseUrl: string;
  apiKeyEnv: string;
  env: Record<string, string | undefined>;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  baseServedModel: string;
  grade(task: HeldOutTaskView, text: string): number;
  evaluator_id: string;
  evaluator_revision: string;
  harness: VersionRef;
  suite: { suite_id: string; revision: string };
  maxTokensPerRequest?: number;
  systemPrompt?: string;
  promptOptimizedSystemPrompt?: string;
}

/** Self-hosted inference costs zero dollars here; usage must be reported by serving.
 * The job seed is recorded by the comparison service, not forwarded by the adapter.
 * Temperature zero is shared by all arms. Without an optimized prompt both base arms coincide.
 */
export function createServingArmEvaluator(
  options: ServingArmOptions,
): SpecialistArmEvaluator {
  const maxTokens = options.maxTokensPerRequest ?? 1024;
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0)
    throw new Error("max_tokens_invalid");
  return {
    evaluator_id: options.evaluator_id,
    evaluator_revision: options.evaluator_revision,
    harness: options.harness,
    suite: options.suite,
    simulated: false,
    async evaluate(input) {
      const baseline =
        input.target.arm === "base" ||
        input.target.arm === "prompt_optimized_baseline";
      if (!baseline && !input.target.adapter?.sha256)
        throw new Error("adapter_missing");
      const served = baseline
        ? options.baseServedModel
        : (input.target.adapter?.sha256 as string);
      const prompt =
        input.target.arm === "prompt_optimized_baseline"
          ? (options.promptOptimizedSystemPrompt ?? options.systemPrompt ?? "")
          : (options.systemPrompt ?? "");
      const model: ModelConfig = {
        id: `vllm/${served}`,
        providerId: "vllm",
        model: served,
        capabilities: { tools: false, vision: false, contextWindow: 32768 },
        pricing: { free: true },
      };
      let remaining = input.budget.max_tokens;
      let requests = 0;
      const adapter = createOpenAICompatibleAdapter(
        {
          id: "vllm",
          kind: "openai-compatible",
          baseUrl: options.baseUrl,
          apiKeyEnv: options.apiKeyEnv,
        },
        {
          env: options.env,
          timeoutMs: options.timeoutMs ?? 30000,
          fetch: (url, init) => {
            input.signal.throwIfAborted();
            requests++;
            return (options.fetch ?? fetch)(url, {
              ...init,
              signal: AbortSignal.any([
                input.signal,
                ...(init?.signal ? [init.signal] : []),
              ]),
            });
          },
        },
      );
      const outcomes: ArmTaskOutcome[] = [];
      for (const task of input.tasks) {
        const started = performance.now();
        const rewards: number[] = [];
        let inputTokens = 0;
        let outputTokens = 0;
        for (let repeat = 0; repeat < input.repeats; repeat++) {
          input.signal.throwIfAborted();
          if (remaining <= 0) throw new Error("budget_exhausted");
          const response = await adapter.complete(
            {
              messages: [
                ...(prompt
                  ? [{ role: "system" as const, content: prompt }]
                  : []),
                { role: "user", content: task.request ?? task.task_id },
              ],
              temperature: 0,
              maxTokens: Math.min(maxTokens, remaining),
            },
            model,
          );
          input.signal.throwIfAborted();
          if (!response.usage) throw new Error("usage_missing");
          inputTokens += response.usage.inputTokens;
          outputTokens += response.usage.outputTokens;
          remaining -= response.usage.inputTokens + response.usage.outputTokens;
          if (remaining < 0) throw new Error("budget_exhausted");
          const reward = options.grade(task, response.content);
          if (!Number.isFinite(reward) || reward < 0 || reward > 1)
            throw new Error("grade_invalid");
          rewards.push(reward);
        }
        outcomes.push({
          task_id: task.task_id,
          rewards,
          cost_usd: 0,
          runtime_ms: performance.now() - started,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
        });
      }
      return {
        agent_manifest_sha256: sha256(
          canonicalJson([
            options.evaluator_id,
            options.evaluator_revision,
            served,
            sha256(prompt),
            maxTokens,
          ]),
        ),
        outcomes,
        model_requests: requests,
      };
    },
  };
}
