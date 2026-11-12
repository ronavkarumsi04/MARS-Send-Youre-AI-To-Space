import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { JobRef, RequestContext } from "@mars/contracts";
import {
  createHeldOutGuard,
  type HeldOutSplit,
  parseHeldOutSplit,
} from "@mars/datasets";
import {
  createHmacReportSigner,
  createServingArmEvaluator,
  createSpecialistComparisonService,
  type HeldOutGuard,
  type SpecialistComparisonVerdict,
  subjectResolverFromRegistry,
  verdictSinkFromRegistry,
} from "@mars/evaluation";
import { loadModelRegistry } from "@mars/providers";
import {
  createVllmServingAttestor,
  loadVllmServingProfile,
  readVllmServing,
  VllmClient,
  vllmOrigin,
} from "@mars/providers-vllm";
import {
  compatibleBase,
  createFileArtifactStore,
  createSpecialistRegistry,
  loadSpecialistTrust,
  type SpecialistRegistry,
} from "@mars/specialists";
import { z } from "zod";
import { CliUsageError } from "./cli-errors";
import { attachVllm } from "./vllm";

export const SPECIALISTS_EVAL_USAGE = [
  "Usage: mars specialists evaluate --specialist ID@REVISION --held-out FILE",
  "         --model-key-env NAME --serving URL",
  "         --registry DIR --trust FILE --signing-key-id ID --vllm-profile FILE --expectations FILE --project ID",
  "         [--owner ID] [--max-tokens N] [--max-duration-ms N] [--prompt-optimized FILE]",
  "  Trust secrets are UTF-8. Temperature is zero; the recorded job seed is not forwarded to serving.",
  "  Self-hosted cost is zero; without --prompt-optimized both baseline prompts are identical.",
  "  Runs the candidate adapter against base on a held-out split (mars.held-out-split/v1)",
  "  under matched budget and seed, then records the verdict with the registry.",
  "  Refuses without a model key in NAME or reachable serving at URL.",
].join("\n");

export type SpecialistsEvalRefusalCode =
  | "usage"
  | "heldout_invalid"
  | "model_key_missing"
  | "serving_missing"
  | "serving_unreachable"
  | "live_evaluation_unavailable"
  | "trust_invalid"
  | "expectations_invalid"
  | "candidate_not_served"
  | "profile_mismatch"
  | "evaluation_refused";

/** A clean refusal; the message names flags and variable names, never values. */
export class SpecialistsEvalRefusal extends CliUsageError {
  constructor(
    readonly code: SpecialistsEvalRefusalCode,
    message: string,
  ) {
    super(`mars specialists evaluate refused (${code}): ${message}`);
  }
}

export interface ServingProbeResult {
  ok: boolean;
  reason?: string;
}

/** What a live evaluation needs; Workstream D wires the registry and serving-backed evaluator. */
export interface LiveSpecialistEvaluation {
  close?(): void;
  context: RequestContext;
  requestEvaluation(
    context: RequestContext,
    id: string,
    revision: string,
  ): Promise<JobRef>;
  verdict(
    context: RequestContext,
    jobId: string,
  ): Promise<SpecialistComparisonVerdict>;
  settled(context: RequestContext, jobId: string): Promise<unknown>;
}

export interface SpecialistsEvalDeps {
  env?: Readonly<Record<string, string | undefined>>;
  probeServing?: (url: URL) => Promise<ServingProbeResult>;
  openEvaluation?: (input: {
    heldOut: HeldOutGuard;
    split: HeldOutSplit;
    servingUrl: URL;
    modelKeyEnv: string;
  }) => Promise<LiveSpecialistEvaluation>;
  write?: (text: string) => void;
}

/** `GET {url}/v1/models`: proves serving answers, never sends a completion. */
export async function probeOpenAiCompatibleServing(
  url: URL,
  apiKey?: string,
): Promise<ServingProbeResult> {
  let response: Response;
  try {
    response = await fetch(new URL("v1/models", withSlash(url)), {
      ...(apiKey ? { headers: { authorization: `Bearer ${apiKey}` } } : {}),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof SyntaxError
          ? "malformed /v1/models response"
          : "unreachable",
    };
  }
  return typeof body === "object" &&
    body !== null &&
    "data" in body &&
    Array.isArray(body.data)
    ? { ok: true }
    : { ok: false, reason: "malformed /v1/models response" };
}

function withSlash(url: URL): URL {
  const copy = new URL(url);
  if (!copy.pathname.endsWith("/")) copy.pathname = `${copy.pathname}/`;
  return copy;
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/**
 * `mars specialists evaluate` (registered in `main.ts` by Workstream D). Every
 * precondition is checked before any registry, evaluator or model is touched.
 */
export async function runSpecialistsEvaluate(
  args: string[],
  deps: SpecialistsEvalDeps = {},
): Promise<SpecialistComparisonVerdict> {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        specialist: { type: "string" },
        "held-out": { type: "string" },
        "model-key-env": { type: "string" },
        serving: { type: "string" },
        registry: { type: "string" },
        trust: { type: "string" },
        "signing-key-id": { type: "string" },
        "vllm-profile": { type: "string" },
        expectations: { type: "string" },
        owner: { type: "string" },
        project: { type: "string" },
        "max-tokens": { type: "string" },
        "max-duration-ms": { type: "string" },
        "prompt-optimized": { type: "string" },
      },
    }));
  } catch {
    throw new SpecialistsEvalRefusal("usage", SPECIALISTS_EVAL_USAGE);
  }
  const ref = typeof values.specialist === "string" ? values.specialist : "";
  const at = ref.lastIndexOf("@");
  if (
    at <= 0 ||
    at === ref.length - 1 ||
    typeof values["held-out"] !== "string"
  ) {
    throw new SpecialistsEvalRefusal("usage", SPECIALISTS_EVAL_USAGE);
  }
  const id = ref.slice(0, at);
  const revision = ref.slice(at + 1);
  const heldOutFile = values["held-out"];

  let split: HeldOutSplit;
  try {
    split = parseHeldOutSplit(JSON.parse(await readFile(heldOutFile, "utf8")));
  } catch {
    throw new SpecialistsEvalRefusal(
      "heldout_invalid",
      `--held-out ${heldOutFile} is not a readable mars.held-out-split/v1 file`,
    );
  }

  const env = deps.env ?? process.env;
  const keyEnv = values["model-key-env"];
  if (typeof keyEnv !== "string" || !ENV_NAME.test(keyEnv)) {
    throw new SpecialistsEvalRefusal(
      "model_key_missing",
      "pass --model-key-env NAME naming the environment variable that holds the model key",
    );
  }
  if (!env[keyEnv]) {
    throw new SpecialistsEvalRefusal(
      "model_key_missing",
      `environment variable ${keyEnv} is not set`,
    );
  }
  if (typeof values.serving !== "string" || values.serving === "") {
    throw new SpecialistsEvalRefusal(
      "serving_missing",
      "pass --serving URL for the OpenAI-compatible server hosting base and adapter",
    );
  }
  let servingUrl: URL;
  try {
    servingUrl = new URL(vllmOrigin(values.serving));
  } catch {
    throw new SpecialistsEvalRefusal(
      "serving_missing",
      "--serving must be a loopback http(s) origin or /v1 URL without credentials, query or fragment",
    );
  }
  const probe = await (deps.probeServing
    ? deps.probeServing(servingUrl)
    : probeOpenAiCompatibleServing(servingUrl, env[keyEnv]));
  if (!probe.ok) {
    throw new SpecialistsEvalRefusal(
      "serving_unreachable",
      `--serving did not answer /v1/models (${probe.reason ?? "unknown"})`,
    );
  }
  const liveFlags = [
    "registry",
    "trust",
    "signing-key-id",
    "vllm-profile",
    "expectations",
    "owner",
    "project",
    "max-tokens",
    "max-duration-ms",
    "prompt-optimized",
  ];
  if (
    !deps.openEvaluation &&
    !liveFlags.some((flag) => values[flag] !== undefined)
  ) {
    throw new SpecialistsEvalRefusal(
      "live_evaluation_unavailable",
      "no serving-backed arm evaluator is wired into this build yet",
    );
  }

  const open =
    deps.openEvaluation ??
    ((input) => openServingEvaluation(input, values, env, id, revision));
  const live = await open({
    heldOut: createHeldOutGuard(split),
    split,
    servingUrl,
    modelKeyEnv: keyEnv,
  });
  try {
    const job = await live.requestEvaluation(live.context, id, revision);
    await live.settled(live.context, job.job_id);
    const verdict = await live.verdict(live.context, job.job_id);
    (deps.write ?? ((text) => process.stdout.write(text)))(
      `${JSON.stringify(
        {
          job_id: verdict.job_id,
          specialist: `${id}@${revision}`,
          outcome: verdict.outcome,
          codes: verdict.codes,
          triples: verdict.triples,
          report_sha256: verdict.report.sha256,
          simulated: verdict.simulated,
          model_requests: verdict.model_requests,
        },
        null,
        2,
      )}\n`,
    );
    return verdict;
  } catch (error) {
    if (error instanceof SpecialistsEvalRefusal) throw error;
    throw new SpecialistsEvalRefusal(
      "evaluation_refused",
      "evaluation failed; check --registry, --held-out and serving budgets",
    );
  } finally {
    live.close?.();
  }
}

const ExpectationsSchema = z
  .object({
    schema: z.literal("mars.held-out-expectations/v1"),
    split_id: z.string().min(1),
    tasks: z.record(
      z
        .object({
          must_include: z.array(z.string()).optional(),
          must_not_include: z.array(z.string()).optional(),
        })
        .strict(),
    ),
  })
  .strict();

async function openServingEvaluation(
  input: Parameters<NonNullable<SpecialistsEvalDeps["openEvaluation"]>>[0],
  values: Record<string, string | boolean | undefined>,
  env: Readonly<Record<string, string | undefined>>,
  id: string,
  revision: string,
): Promise<LiveSpecialistEvaluation> {
  const required = (flag: string) => {
    const value = values[flag];
    if (typeof value !== "string" || !value)
      throw new SpecialistsEvalRefusal("usage", `pass --${flag}`);
    return value;
  };
  const root = resolve(required("registry"));
  const trustFile = required("trust");
  const signingKey = required("signing-key-id");
  const profileFile = required("vllm-profile");
  const expectationsFile = required("expectations");
  const project = required("project");
  const owner = typeof values.owner === "string" ? values.owner : "local";
  const evaluatorId = "mars-serving-evaluator";
  let trust: Awaited<ReturnType<typeof loadSpecialistTrust>>;
  try {
    trust = await loadSpecialistTrust(trustFile, { ...env });
  } catch {
    throw new SpecialistsEvalRefusal(
      "trust_invalid",
      "check --trust and its secret_env variables",
    );
  }
  const authority = trust.authorities.find(
    (item) => item.key_id === signingKey,
  );
  if (
    !authority ||
    !authority.evaluator_ids.includes(evaluatorId) ||
    !authority.owner_ids.includes(owner)
  )
    throw new SpecialistsEvalRefusal(
      "trust_invalid",
      "--signing-key-id must authorize the owner and mars-serving-evaluator",
    );
  let expectations: z.infer<typeof ExpectationsSchema>;
  try {
    expectations = ExpectationsSchema.parse(
      JSON.parse(await readFile(expectationsFile, "utf8")),
    );
    if (
      expectations.split_id !== input.split.split_id ||
      input.split.tasks.some(
        (task) => !Object.hasOwn(expectations.tasks, task.task_id),
      )
    )
      throw new Error();
  } catch {
    throw new SpecialistsEvalRefusal(
      "expectations_invalid",
      "--expectations must cover every --held-out task in the split",
    );
  }
  const positive = (flag: string, fallback: number) => {
    const number = values[flag] === undefined ? fallback : Number(values[flag]);
    if (!Number.isSafeInteger(number) || number <= 0)
      throw new SpecialistsEvalRefusal(
        "usage",
        `--${flag} must be a positive integer`,
      );
    return number;
  };
  const maxTokens = positive("max-tokens", 100000);
  const duration = positive("max-duration-ms", 30000);
  let optimized: string | undefined;
  if (typeof values["prompt-optimized"] === "string") {
    try {
      optimized = await readFile(values["prompt-optimized"], "utf8");
    } catch {
      throw new SpecialistsEvalRefusal(
        "usage",
        "--prompt-optimized must be readable",
      );
    }
  }
  let attached: Awaited<ReturnType<typeof attachVllm>>;
  let profile: Awaited<ReturnType<typeof loadVllmServingProfile>>;
  const url = input.servingUrl.origin;
  try {
    profile = await loadVllmServingProfile(profileFile);
    attached = await attachVllm(
      {
        url,
        allowRemote: false,
        apiKeyEnv: input.modelKeyEnv,
        profilePath: profileFile,
        devRuntimeLora: false,
      },
      await loadModelRegistry({ env: { ...env } }),
      { env: { ...env } },
    );
  } catch {
    throw new SpecialistsEvalRefusal(
      "serving_unreachable",
      "--serving and --vllm-profile must attest a pinned loopback vLLM",
    );
  }
  const client = new VllmClient({
    url,
    apiKeyEnv: input.modelKeyEnv,
    env: { ...env },
  });
  const artifacts = createFileArtifactStore(resolve(root, "artifacts"));
  let registry: SpecialistRegistry;
  const service = createSpecialistComparisonService({
    stateDir: resolve(root, "evaluations"),
    artifacts,
    subjects: {
      resolve: (ctx, specialist, rev) =>
        subjectResolverFromRegistry(registry).resolve(ctx, specialist, rev),
    },
    heldOut: input.heldOut,
    evaluator: createServingArmEvaluator({
      baseUrl: `${url}/v1`,
      apiKeyEnv: input.modelKeyEnv,
      env: { ...env },
      baseServedModel: profile.served_model_name,
      evaluator_id: evaluatorId,
      evaluator_revision: "1",
      harness: { component: "mars/expectations", revision: "1" },
      suite: { suite_id: input.split.split_id, revision: "1" },
      ...(optimized !== undefined
        ? { promptOptimizedSystemPrompt: optimized }
        : {}),
      grade(task, text) {
        const rule = expectations.tasks[task.task_id];
        return rule &&
          (rule.must_include ?? []).every((part) => text.includes(part)) &&
          (rule.must_not_include ?? []).every((part) => !text.includes(part))
          ? 1
          : 0;
      },
    }),
    signer: createHmacReportSigner(authority),
    verdicts: {
      record: (ctx, entry) =>
        verdictSinkFromRegistry(registry).record(ctx, entry),
    },
  });
  registry = createSpecialistRegistry({
    rootDir: root,
    artifacts,
    catalog: attached.registry,
    evidenceVerifier: trust.evidenceVerifier,
    servingAttestor: createVllmServingAttestor({ client, profile }),
    evaluation: {
      service,
      artifacts,
      defaultBudget: {
        max_tokens: maxTokens,
        max_usd: 0,
        max_duration_ms: duration,
        max_depth: 1,
        max_concurrency: 1,
      },
    },
  });
  const context: RequestContext = {
    schema_version: 1,
    scope: { owner_id: owner, project_id: project },
    request_id: randomUUID(),
  };
  try {
    const subject = (await registry.inspect(context, id)).revisions.find(
      (view) => view.registration.revision === revision,
    );
    if (subject && !compatibleBase(subject.registration, profile.base_model))
      throw new SpecialistsEvalRefusal(
        "profile_mismatch",
        "--vllm-profile base must match the registered --specialist base",
      );
    const snapshot = await readVllmServing(client, profile);
    if (
      !subject ||
      (subject.registration.adapter &&
        !snapshot.adapters.some(
          (card) => card.id === subject.registration.adapter?.sha256,
        ))
    )
      throw new SpecialistsEvalRefusal(
        "candidate_not_served",
        "--specialist adapter must be loaded by --serving",
      );
  } catch (error) {
    registry.close();
    if (error instanceof SpecialistsEvalRefusal) throw error;
    throw new SpecialistsEvalRefusal(
      "candidate_not_served",
      "check --specialist and --serving",
    );
  }
  return {
    context,
    requestEvaluation: (ctx, specialist, rev) =>
      registry.requestEvaluation(ctx, specialist, rev),
    settled: (ctx, job) => service.settled(ctx, job),
    verdict: (ctx, job) => service.verdict(ctx, job),
    close: () => registry.close(),
  };
}
