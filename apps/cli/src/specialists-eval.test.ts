import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ArtifactRef, RequestContext } from "@mars/contracts";
import { sha256 } from "@mars/contracts/canonical";
import { HELD_OUT_SPLIT_SCHEMA, requestSha256 } from "@mars/datasets";
import {
  createFixtureArmEvaluator,
  createHmacReportSigner,
  createSpecialistComparisonService,
  subjectResolverFromRegistry,
} from "../../../packages/evaluation/src/index";
import type { SpecialistRegistry } from "../../../packages/specialists/src/index";
import {
  context,
  createRegistry,
  EVIDENCE_SECRET,
  installNoNetworkStub,
  MemoryArtifacts,
  makeBaseline,
  makeLineageArtifact,
  makeSpecialistFixture,
} from "../../../packages/specialists/tests/helpers";
import {
  runSpecialistsEvaluate,
  SpecialistsEvalRefusal,
} from "./specialists-eval";

const KEY = "sk-test-not-a-real-key-123456";
const DOMAIN = "coding/mechanical-edit";
let root: string;
let heldOut: string;
let restoreFetch: () => void;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mars-specialists-eval-"));
  heldOut = path.join(root, "heldout.json");
  await writeFile(
    heldOut,
    JSON.stringify({
      schema: HELD_OUT_SPLIT_SCHEMA,
      split_id: "cli-heldout",
      tasks: ["ho-1", "ho-2"].map((task_id) => ({
        task_id,
        domain: DOMAIN,
        role: "worker",
        complexity: "medium",
        request: `held-out request ${task_id}`,
      })),
    }),
  );
  restoreFetch = installNoNetworkStub();
});
afterEach(async () => {
  restoreFetch();
  await rm(root, { recursive: true, force: true });
});

const args = (extra: string[] = []) => [
  "--specialist",
  "specialist-1@1",
  "--held-out",
  heldOut,
  ...extra,
];

async function refusal(promise: Promise<unknown>) {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(SpecialistsEvalRefusal);
  expect((error as Error).message).not.toContain(KEY);
  return error as SpecialistsEvalRefusal;
}

test("refuses cleanly without a model key or serving, before touching anything", async () => {
  let probed = 0;
  let opened = 0;
  const deps = {
    probeServing: async () => {
      probed += 1;
      return { ok: true };
    },
    openEvaluation: async () => {
      opened += 1;
      throw new Error("must not open");
    },
  };
  expect((await refusal(runSpecialistsEvaluate([], deps))).code).toBe("usage");
  expect(
    (
      await refusal(
        runSpecialistsEvaluate(
          [
            "--specialist",
            "specialist-1@1",
            "--held-out",
            path.join(root, "x"),
          ],
          deps,
        ),
      )
    ).code,
  ).toBe("heldout_invalid");
  expect((await refusal(runSpecialistsEvaluate(args(), deps))).code).toBe(
    "model_key_missing",
  );
  const unset = await refusal(
    runSpecialistsEvaluate(args(["--model-key-env", "MARS_EVAL_KEY"]), {
      ...deps,
      env: {},
    }),
  );
  expect(unset.code).toBe("model_key_missing");
  expect(unset.message).toContain("MARS_EVAL_KEY is not set");
  const withKey = { ...deps, env: { MARS_EVAL_KEY: KEY } };
  expect(
    (
      await refusal(
        runSpecialistsEvaluate(
          args(["--model-key-env", "MARS_EVAL_KEY"]),
          withKey,
        ),
      )
    ).code,
  ).toBe("serving_missing");
  expect(
    (
      await refusal(
        runSpecialistsEvaluate(
          args(["--model-key-env", "MARS_EVAL_KEY", "--serving", "file:///x"]),
          withKey,
        ),
      )
    ).code,
  ).toBe("serving_missing");
  expect(probed).toBe(0);
  expect(opened).toBe(0);
});

test("refuses when serving does not answer or no live evaluator is wired", async () => {
  const live = args([
    "--model-key-env",
    "MARS_EVAL_KEY",
    "--serving",
    "http://127.0.0.1:9/",
  ]);
  const env = { MARS_EVAL_KEY: KEY };
  // Default probe: the network stub makes /v1/models unreachable.
  const unreachable = await refusal(runSpecialistsEvaluate(live, { env }));
  expect(unreachable.code).toBe("serving_unreachable");
  expect(unreachable.message).toContain("unreachable");
  const unwired = await refusal(
    runSpecialistsEvaluate(live, {
      env,
      probeServing: async () => ({ ok: true }),
    }),
  );
  expect(unwired.code).toBe("live_evaluation_unavailable");
});

test("refuses a successful models probe with a non-JSON body as malformed", async () => {
  restoreFetch();
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response("hello", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
  });
  try {
    const error = await refusal(
      runSpecialistsEvaluate(
        args([
          "--model-key-env",
          "MARS_EVAL_KEY",
          "--serving",
          server.url.href,
        ]),
        { env: { MARS_EVAL_KEY: KEY } },
      ),
    );
    expect(error.code).toBe("serving_unreachable");
    expect(error.message).toContain("malformed");
    expect(error.message).not.toContain(KEY);
  } finally {
    await server.stop(true);
  }
});

test("with key, serving and an injected evaluation it records a verdict", async () => {
  const memory = new MemoryArtifacts();
  const artifacts = {
    get: (ctx: RequestContext, ref: ArtifactRef) => memory.get(ctx, ref),
    async put(_ctx: RequestContext, bytes: Uint8Array, media_type: string) {
      const ref = {
        artifact_id: `artifact-${sha256(bytes).slice(0, 16)}`,
        sha256: sha256(bytes),
        media_type,
        byte_length: bytes.byteLength,
      };
      memory.set(ref, bytes);
      return ref;
    },
  };
  const outcomes: string[] = [];
  let written = "";
  const verdict = await runSpecialistsEvaluate(
    args([
      "--model-key-env",
      "MARS_EVAL_KEY",
      "--serving",
      "http://127.0.0.1:9",
    ]),
    {
      env: { MARS_EVAL_KEY: KEY },
      probeServing: async () => ({ ok: true }),
      write: (text) => {
        written += text;
      },
      async openEvaluation({ heldOut: guard }) {
        let registry: SpecialistRegistry | undefined;
        const service = createSpecialistComparisonService({
          stateDir: path.join(root, "evaluation"),
          artifacts,
          subjects: {
            resolve: (ctx, id, revision) =>
              subjectResolverFromRegistry(
                registry as SpecialistRegistry,
              ).resolve(ctx, id, revision),
          },
          heldOut: guard,
          evaluator: createFixtureArmEvaluator({
            evaluator_id: "eval-1",
            pass: () => true,
          }),
          signer: createHmacReportSigner({
            key_id: "test-key",
            secret: EVIDENCE_SECRET,
          }),
          verdicts: {
            async record(_ctx, entry) {
              outcomes.push(entry.value.outcome);
            },
          },
        });
        registry = createRegistry(path.join(root, "registry"), memory, {
          evaluation: {
            service,
            artifacts,
            defaultBudget: {
              max_tokens: 10_000,
              max_usd: 1,
              max_duration_ms: 30_000,
              max_depth: 1,
              max_concurrency: 1,
            },
          },
        });
        await registry.registerBaseline(context, makeBaseline());
        const fixture = await makeSpecialistFixture(memory, {
          domains: [DOMAIN],
          datasetLineage: await makeLineageArtifact(memory, context.scope, {
            requestSha256s: [requestSha256("unrelated training request")],
          }),
        });
        await registry.registerSpecialist(context, fixture.registration);
        const ready = registry;
        return {
          context,
          requestEvaluation: (ctx, id, revision) =>
            ready.requestEvaluation(ctx, id, revision),
          settled: (ctx, jobId) => service.settled(ctx, jobId),
          verdict: (ctx, jobId) => service.verdict(ctx, jobId),
        };
      },
    },
  );
  expect(verdict.outcome).toBe("no_improvement");
  expect(outcomes).toEqual(["no_improvement"]);
  const printed = JSON.parse(written) as Record<string, unknown>;
  expect(printed).toMatchObject({
    specialist: "specialist-1@1",
    outcome: "no_improvement",
    simulated: true,
    model_requests: 0,
  });
  expect(written).not.toContain(KEY);
});
