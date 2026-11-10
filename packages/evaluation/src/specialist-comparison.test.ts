import { afterEach, beforeEach, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { ArtifactRef, Budget, RequestContext } from "@mars/contracts";
import { sha256 } from "@mars/contracts/canonical";
import {
  createHeldOutGuard,
  findHeldOutLeakage,
  HELD_OUT_SPLIT_SCHEMA,
  type HeldOutSplit,
  heldOutSplitSha256,
} from "../../datasets/src/index";
import {
  type SpecialistRegistry,
  verifyEvidence,
} from "../../specialists/src/index";
import {
  context,
  createRegistry,
  createTempRoot,
  EVIDENCE_SECRET,
  evidenceVerifier,
  installNoNetworkStub,
  MemoryArtifacts,
  makeBaseline,
  makeLineageArtifact,
  makeSpecialistFixture,
  removeTempRoot,
} from "../../specialists/tests/helpers";
import {
  createFixtureArmEvaluator,
  createHmacReportSigner,
  createSpecialistComparisonService,
  SpecialistComparisonError,
  type SpecialistComparisonService,
  type SpecialistComparisonVerdict,
  type SpecialistVerdictSink,
  subjectResolverFromRegistry,
} from "./index";

const DOMAIN = "coding/mechanical-edit";
const budget: Budget = {
  max_tokens: 10_000,
  max_usd: 3,
  max_duration_ms: 30_000,
  max_depth: 1,
  max_concurrency: 1,
};
const split: HeldOutSplit = {
  schema: HELD_OUT_SPLIT_SCHEMA,
  split_id: "m7-heldout",
  tasks: [
    { task_id: "ho-1", domain: DOMAIN, role: "worker", complexity: "medium" },
    { task_id: "ho-2", domain: DOMAIN, role: "worker", complexity: "medium" },
    { task_id: "ho-3", domain: DOMAIN, role: "worker", complexity: "medium" },
    { task_id: "ho-4", domain: DOMAIN, role: "worker", complexity: "medium" },
    {
      task_id: "ho-other",
      domain: "docs/other",
      role: "worker",
      complexity: "medium",
    },
  ],
};

let root: string;
let restoreFetch: () => void;
beforeEach(async () => {
  root = await createTempRoot();
  restoreFetch = installNoNetworkStub();
});
afterEach(async () => {
  restoreFetch();
  await removeTempRoot(root);
});

function evidenceArtifacts(memory: MemoryArtifacts) {
  return {
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
}

async function setup(
  options: {
    trainTaskIds?: string[];
    producerId?: string;
    datasetSha256?: string;
    pass?: Parameters<typeof createFixtureArmEvaluator>[0] extends infer O
      ? O extends { pass?: infer P }
        ? P
        : never
      : never;
    repeats?: number;
    costUsdPerTask?: number;
  } = {},
) {
  const memory = new MemoryArtifacts();
  const artifacts = evidenceArtifacts(memory);
  const recorded: Array<{
    job_id: string;
    verdict: SpecialistComparisonVerdict;
  }> = [];
  const evaluator = createFixtureArmEvaluator({
    evaluator_id: "eval-1",
    ...(options.pass ? { pass: options.pass } : {}),
    ...(options.costUsdPerTask !== undefined
      ? { cost_usd_per_task: options.costUsdPerTask }
      : {}),
  });
  let registry: SpecialistRegistry | undefined;
  const sink: SpecialistVerdictSink = {
    async record(_ctx, entry) {
      recorded.push({ job_id: entry.job.job_id, verdict: entry.value });
    },
  };
  const service: SpecialistComparisonService =
    createSpecialistComparisonService({
      stateDir: path.join(root, "evaluation"),
      artifacts,
      subjects: {
        resolve: (ctx, id, revision) =>
          subjectResolverFromRegistry(registry as SpecialistRegistry).resolve(
            ctx,
            id,
            revision,
          ),
      },
      heldOut: createHeldOutGuard(split),
      evaluator,
      signer: createHmacReportSigner({
        key_id: "test-key",
        secret: EVIDENCE_SECRET,
      }),
      verdicts: sink,
      ...(options.repeats ? { repeats: options.repeats } : {}),
    });
  registry = createRegistry(path.join(root, "registry"), memory, {
    evaluation: { service, artifacts, defaultBudget: budget },
  });
  await registry.registerBaseline(context, makeBaseline());
  const lineage = await makeLineageArtifact(memory, context.scope, {
    trainTaskIds: options.trainTaskIds ?? ["train-1", "train-2"],
    validationTaskIds: ["validation-1"],
    ...(options.producerId ? { producerId: options.producerId } : {}),
    ...(options.datasetSha256 ? { datasetSha256: options.datasetSha256 } : {}),
  });
  const fixture = await makeSpecialistFixture(memory, {
    datasetLineage: lineage,
    domains: [DOMAIN],
  });
  await registry.registerSpecialist(context, fixture.registration);
  return { memory, registry, service, evaluator, recorded, fixture };
}

const candidateWins = ({ arm, task_id }: { arm: string; task_id: string }) =>
  arm === "candidate" || task_id === "ho-1";

test("request → job → signed verdict round-trip under matched conditions", async () => {
  const { memory, registry, service, evaluator, recorded, fixture } =
    await setup({ pass: candidateWins, repeats: 3 });
  const job = await registry.requestEvaluation(context, "specialist-1", "1");
  expect(await registry.evaluationJobs(context, "specialist-1", "1")).toEqual([
    job,
  ]);
  const settled = await service.settled(context, job.job_id);
  expect(settled.status).toBe("completed");
  expect(settled.artifacts).toHaveLength(2);
  expect(settled.cost_usd).toBe(0);

  // Matched: every arm saw the same tasks, repeats, seed and per-arm budget.
  expect(evaluator.calls.map((call) => call.target.arm)).toEqual([
    "base",
    "prompt_optimized_baseline",
    "candidate",
  ]);
  const [first, ...rest] = evaluator.calls;
  for (const call of rest) {
    expect(call.tasks).toEqual(first?.tasks ?? []);
    expect(call.seed).toBe(first?.seed ?? "");
    expect(call.repeats).toBe(3);
    expect(call.budget).toEqual(first?.budget ?? budget);
  }
  expect(first?.budget.max_usd).toBe(1);
  expect(first?.tasks.map((task) => task.task_id)).toEqual([
    "ho-1",
    "ho-2",
    "ho-3",
    "ho-4",
  ]);
  expect(first?.target.model).toEqual(fixture.registration.base_model);

  const verdict = await service.verdict(context, job.job_id);
  expect(verdict.outcome).toBe("improved");
  expect(verdict.codes).toEqual([]);
  expect(verdict.triples[0]).toMatchObject({
    pass_rate: 1,
    base_pass_rate: 0.25,
    delta_vs_base: 0.75,
    gate_passed: true,
  });
  expect(verdict.simulated).toBe(true);
  expect(verdict.model_requests).toBe(0);
  expect(verdict.heldout.split_sha256).toBe(heldOutSplitSha256(split));
  expect(recorded).toEqual([{ job_id: job.job_id, verdict }]);

  // The registry's own evidence verifier accepts the signed report.
  const registryVerdict = await verifyEvidence(
    context,
    { ...fixture.registration, evaluation: verdict.report },
    fixture.candidateSha256,
    {
      artifacts: memory,
      evidenceVerifier: evidenceVerifier(),
      allowSyntheticFixtures: true,
      currentProductionRevision: null,
    },
  );
  expect(registryVerdict.status).toBe("evaluated");
  expect(registryVerdict.codes).toEqual([]);
  // Without the synthetic-fixture allowance the simulated report cannot promote.
  const strict = await verifyEvidence(
    context,
    { ...fixture.registration, evaluation: verdict.report },
    fixture.candidateSha256,
    { artifacts: memory, evidenceVerifier: evidenceVerifier() },
  );
  expect(strict.status).toBe("rejected");
});

test("no improvement over base is recorded honestly, as is a regression", async () => {
  const same = await setup({ pass: ({ task_id }) => task_id !== "ho-4" });
  const job = await same.registry.requestEvaluation(
    context,
    "specialist-1",
    "1",
  );
  expect((await same.service.settled(context, job.job_id)).status).toBe(
    "completed",
  );
  const verdict = await same.service.verdict(context, job.job_id);
  expect(verdict.outcome).toBe("no_improvement");
  expect(verdict.codes).toEqual(["no_delta_vs_base"]);
  expect(verdict.triples[0]?.delta_vs_base).toBe(0);
  expect(same.recorded.map((entry) => entry.verdict.outcome)).toEqual([
    "no_improvement",
  ]);
  await removeTempRoot(root);
  root = await createTempRoot();

  const worse = await setup({
    pass: ({ arm, task_id }) => arm !== "candidate" || task_id === "ho-1",
  });
  const worseJob = await worse.registry.requestEvaluation(
    context,
    "specialist-1",
    "1",
  );
  await worse.service.settled(context, worseJob.job_id);
  const regressed = await worse.service.verdict(context, worseJob.job_id);
  expect(regressed.outcome).toBe("regressed");
  expect(regressed.regressions).toBe(6);
  expect(regressed.codes).toEqual([
    "gate_failed",
    "regressions_exceeded",
    "worse_than_base",
  ]);
  expect(worse.recorded).toHaveLength(1);
});

test("held-out tasks in the training lineage are refused before any arm runs", async () => {
  const leaked = await setup({ trainTaskIds: ["train-1", "ho-2"] });
  const error = await leaked.registry
    .requestEvaluation(context, "specialist-1", "1")
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(SpecialistComparisonError);
  expect((error as SpecialistComparisonError).code).toBe("heldout_leakage");
  expect((error as Error).message).toContain("ho-2 (training-task)");
  expect(leaked.evaluator.calls).toHaveLength(0);
  expect(leaked.recorded).toHaveLength(0);
  expect(
    await leaked.registry.evaluationJobs(context, "specialist-1", "1"),
  ).toEqual([]);
  await expect(
    readdir(path.join(root, "evaluation", "specialist-comparisons")),
  ).rejects.toThrow();
  await removeTempRoot(root);
  root = await createTempRoot();

  const splitAsDataset = await setup({
    datasetSha256: heldOutSplitSha256(split),
  });
  await expect(
    splitAsDataset.registry.requestEvaluation(context, "specialist-1", "1"),
  ).rejects.toMatchObject({ code: "heldout_leakage" });
  await removeTempRoot(root);
  root = await createTempRoot();

  const selfGraded = await setup({ producerId: "eval-1" });
  await expect(
    selfGraded.registry.requestEvaluation(context, "specialist-1", "1"),
  ).rejects.toMatchObject({ code: "evaluator_not_independent" });
  expect(selfGraded.evaluator.calls).toHaveLength(0);
});

test("held-out leakage helper matches ids, normalized requests and dataset digests", () => {
  const withRequests: HeldOutSplit = {
    ...split,
    tasks: [
      {
        ...split.tasks[0],
        request: "Rename  the Widget",
      } as HeldOutSplit["tasks"][number],
      split.tasks[1] as HeldOutSplit["tasks"][number],
    ],
  };
  expect(
    findHeldOutLeakage(withRequests, {
      task_ids: ["ho-2"],
      requests: ["rename the widget"],
    }),
  ).toEqual([
    { task_id: "ho-1", reason: "training-request" },
    { task_id: "ho-2", reason: "training-task" },
  ]);
  expect(findHeldOutLeakage(withRequests, { task_ids: ["other"] })).toEqual([]);
  expect(
    heldOutSplitSha256({ ...split, tasks: [...split.tasks].reverse() }),
  ).toBe(heldOutSplitSha256(split));
});

test("budget overruns fail the job; restarted services mark orphaned jobs failed", async () => {
  const pricey = await setup({ costUsdPerTask: 0.5 });
  const job = await pricey.registry.requestEvaluation(
    context,
    "specialist-1",
    "1",
  );
  const settled = await pricey.service.settled(context, job.job_id);
  expect(settled.status).toBe("failed");
  expect(settled.artifacts).toEqual([]);
  await expect(pricey.service.verdict(context, job.job_id)).rejects.toThrow(
    "budget exceeded on arm base",
  );
  expect(pricey.recorded).toHaveLength(0);
  await expect(
    pricey.service.inspect(
      { ...context, scope: { owner_id: "owner-2", project_id: "project-1" } },
      job.job_id,
    ),
  ).rejects.toMatchObject({ code: "not_found" });
  const workspaceA = {
    ...context,
    scope: { ...context.scope, workspace_id: "workspace-a" },
  };
  const projectWide = pricey.registry as SpecialistRegistry;
  const workspaceService = createSpecialistComparisonService({
    stateDir: path.join(root, "evaluation"),
    artifacts: evidenceArtifacts(pricey.memory),
    subjects: {
      resolve: (_ctx, id, revision) =>
        subjectResolverFromRegistry(projectWide).resolve(context, id, revision),
    },
    heldOut: createHeldOutGuard(split),
    evaluator: createFixtureArmEvaluator({ evaluator_id: "eval-1" }),
    signer: createHmacReportSigner({ key_id: "k", secret: EVIDENCE_SECRET }),
    verdicts: { record: async () => {} },
  });
  const scoped = await workspaceService.submitComparison(
    workspaceA,
    job.input_manifest,
    budget,
  );
  await workspaceService.settled(workspaceA, scoped.job_id);
  expect(
    (await workspaceService.inspect(workspaceA, scoped.job_id)).status,
  ).toBe("completed");
  for (const other of [
    context,
    { ...context, scope: { ...context.scope, workspace_id: "workspace-b" } },
  ]) {
    await expect(
      workspaceService.inspect(other, scoped.job_id),
    ).rejects.toMatchObject({ code: "not_found" });
  }

  const restarted = createSpecialistComparisonService({
    stateDir: path.join(root, "evaluation"),
    artifacts: evidenceArtifacts(pricey.memory),
    subjects: { resolve: async () => undefined },
    heldOut: createHeldOutGuard(split),
    evaluator: createFixtureArmEvaluator(),
    signer: createHmacReportSigner({ key_id: "k", secret: EVIDENCE_SECRET }),
    verdicts: { record: async () => {} },
  });
  expect((await restarted.inspect(context, job.job_id)).status).toBe("failed");

  const hung = createSpecialistComparisonService({
    stateDir: path.join(root, "evaluation"),
    artifacts: evidenceArtifacts(pricey.memory),
    subjects: {
      resolve: (ctx, id, revision) =>
        subjectResolverFromRegistry(projectWide).resolve(ctx, id, revision),
    },
    heldOut: createHeldOutGuard(split),
    evaluator: {
      ...createFixtureArmEvaluator({ evaluator_id: "eval-1" }),
      evaluate: ({ signal }) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        ),
    },
    signer: createHmacReportSigner({ key_id: "k", secret: EVIDENCE_SECRET }),
    verdicts: { record: async () => {} },
  });
  const orphan = await hung.submitComparison(
    context,
    job.input_manifest,
    budget,
  );
  await expect(
    restarted.settled(
      { ...context, scope: { owner_id: "owner-2", project_id: "project-1" } },
      orphan.job_id,
    ),
  ).rejects.toMatchObject({ code: "not_found" });
  const orphaned = await restarted.settled(context, orphan.job_id);
  expect(orphaned.status).toBe("failed");
  await hung.cancel(context, orphan.job_id);
});

function standaloneService(
  memory: MemoryArtifacts,
  registry: SpecialistRegistry,
  overrides: Partial<Parameters<typeof createSpecialistComparisonService>[0]>,
) {
  return createSpecialistComparisonService({
    stateDir: path.join(root, "standalone"),
    artifacts: evidenceArtifacts(memory),
    subjects: subjectResolverFromRegistry(registry),
    heldOut: createHeldOutGuard(split),
    evaluator: createFixtureArmEvaluator({ evaluator_id: "eval-1" }),
    signer: createHmacReportSigner({ key_id: "k", secret: EVIDENCE_SECRET }),
    verdicts: { record: async () => {} },
    ...overrides,
  });
}

test("a verdict the registry sink did not record is never returned", async () => {
  const { memory, registry } = await setup();
  const job = await registry.requestEvaluation(context, "specialist-1", "1");
  const service = standaloneService(memory, registry, {
    verdicts: {
      record: async () => {
        throw new Error("registry unavailable");
      },
    },
  });
  const failed = await service.submitComparison(
    context,
    job.input_manifest,
    budget,
  );
  expect((await service.settled(context, failed.job_id)).status).toBe("failed");
  await expect(service.verdict(context, failed.job_id)).rejects.toMatchObject({
    code: "not_settled",
  });
});

test("cancelling during the last arm records no verdict", async () => {
  const { memory, registry } = await setup();
  const job = await registry.requestEvaluation(context, "specialist-1", "1");
  const fixture = createFixtureArmEvaluator({ evaluator_id: "eval-1" });
  let reached!: () => void;
  const atCandidate = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const recorded: string[] = [];
  const service = standaloneService(memory, registry, {
    evaluator: {
      ...fixture,
      async evaluate(input) {
        if (input.target.arm === "candidate") {
          reached();
          await gate;
        }
        return fixture.evaluate(input);
      },
    },
    verdicts: {
      record: async (_ctx, entry) => {
        recorded.push(entry.job.job_id);
      },
    },
  });
  const running = await service.submitComparison(
    context,
    job.input_manifest,
    budget,
  );
  await atCandidate;
  const cancelled = service.cancel(context, running.job_id);
  release();
  await cancelled;
  expect((await service.inspect(context, running.job_id)).status).toBe(
    "cancelled",
  );
  expect(recorded).toEqual([]);
});

test("a budget too small to split across matched arms is refused at submit", async () => {
  const { registry, evaluator, recorded } = await setup();
  await expect(
    registry.requestEvaluation(context, "specialist-1", "1", {
      ...budget,
      max_tokens: 2,
    }),
  ).rejects.toMatchObject({ code: "budget_insufficient" });
  expect(evaluator.calls).toHaveLength(0);
  expect(recorded).toHaveLength(0);
});
