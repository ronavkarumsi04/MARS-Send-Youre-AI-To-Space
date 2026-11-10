import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { JobRef, RequestContext } from "@mars/contracts";
import {
  createHeldOutGuard,
  type HeldOutSplit,
  parseHeldOutSplit,
} from "@mars/datasets";
import type {
  HeldOutGuard,
  SpecialistComparisonVerdict,
} from "../../../packages/evaluation/src/index";
import { CliUsageError } from "./cli-errors";

export const SPECIALISTS_EVAL_USAGE = [
  "Usage: mars specialists evaluate --specialist ID@REVISION --held-out FILE",
  "         --model-key-env NAME --serving URL",
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
  | "live_evaluation_unavailable";

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
): Promise<ServingProbeResult> {
  try {
    const response = await fetch(new URL("v1/models", withSlash(url)), {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    const body = (await response.json()) as { data?: unknown };
    return Array.isArray(body.data)
      ? { ok: true }
      : { ok: false, reason: "malformed /v1/models response" };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
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
    servingUrl = new URL(values.serving);
    if (servingUrl.protocol !== "http:" && servingUrl.protocol !== "https:") {
      throw new Error("protocol");
    }
  } catch {
    throw new SpecialistsEvalRefusal(
      "serving_missing",
      "--serving must be an http(s) URL",
    );
  }
  const probe = await (deps.probeServing ?? probeOpenAiCompatibleServing)(
    servingUrl,
  );
  if (!probe.ok) {
    throw new SpecialistsEvalRefusal(
      "serving_unreachable",
      `--serving did not answer /v1/models (${probe.reason ?? "unknown"})`,
    );
  }
  if (!deps.openEvaluation) {
    throw new SpecialistsEvalRefusal(
      "live_evaluation_unavailable",
      "no serving-backed arm evaluator is wired into this build yet",
    );
  }

  const live = await deps.openEvaluation({
    heldOut: createHeldOutGuard(split),
    split,
    servingUrl,
    modelKeyEnv: keyEnv,
  });
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
}
