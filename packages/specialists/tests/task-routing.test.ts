import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import type { RequestContext } from "@mars/contracts";
import {
  type RoutingDecision,
  type ServingAttestor,
  SpecialistRegistryError,
  SpecialistTaskRouter,
  type TaskRoutingStep,
} from "../src";
import {
  artifactRef,
  context,
  createRegistry,
  createTempRoot,
  installNoNetworkStub,
  MemoryArtifacts,
  makeBaseline,
  makeLineageArtifact,
  makeSpecialistFixture,
  removeTempRoot,
  routingRequest,
} from "./helpers";

const roots: string[] = [];
let restoreFetch: (() => void) | undefined;
beforeAll(() => {
  restoreFetch = installNoNetworkStub();
});
afterAll(() => restoreFetch?.());
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

async function setup(attestor?: ServingAttestor) {
  const root = await createTempRoot();
  roots.push(root);
  const artifacts = new MemoryArtifacts();
  const registry = createRegistry(
    root,
    artifacts,
    attestor ? { servingAttestor: attestor } : {},
  );
  await registry.registerBaseline(context, makeBaseline());
  const steps: TaskRoutingStep[] = [];
  const router = new SpecialistTaskRouter(registry, {
    record: async (_context, step) => {
      steps.push(step);
    },
  });
  return { root, artifacts, registry, router, steps };
}

/** Fake serving attestor that can be flipped mid-task. */
function switchableAttestor(adapterSha: string, chatTemplateSha: string) {
  const state = { attested: true, throws: false };
  const attestor: ServingAttestor = {
    async attest() {
      if (state.throws) throw new Error("serving host unreachable");
      if (!state.attested) return null;
      return {
        model_id: "specialist-model",
        provider_id: "local",
        provider_model: "specialist-upstream",
        base_model: { component: "model/base", revision: "1" },
        tokenizer: { component: "tokenizer/base", revision: "1" },
        chat_template_sha256: chatTemplateSha,
        adapter_formats: ["peft-lora"],
        loaded_adapter_sha256s: [adapterSha],
      };
    },
  };
  return { state, attestor };
}

async function adapterSetup() {
  const adapter = artifactRef("adapter-bytes", new Uint8Array([1, 2, 3]));
  const chatTemplate = artifactRef("template-adapter-specialist");
  const fake = switchableAttestor(adapter.sha256, chatTemplate.sha256);
  const env = await setup(fake.attestor);
  const lineage = await makeLineageArtifact(env.artifacts, context.scope, {
    specialistId: "adapter-specialist",
  });
  const fixture = await makeSpecialistFixture(env.artifacts, {
    specialistId: "adapter-specialist",
    adapter,
    adapterFormat: "peft-lora",
    adapterSpec: {
      format: "peft-lora",
      base_model: { component: "model/base", revision: "1" },
      tokenizer: { component: "tokenizer/base", revision: "1" },
      chat_template_sha256: chatTemplate.sha256,
    },
    chatTemplate,
    datasetLineage: lineage,
  });
  await env.registry.registerSpecialist(context, fixture.registration);
  await env.registry.promote(context, "adapter-specialist", "1", null);
  return { ...env, fake, adapter };
}

const ADAPTER_REF = "specialist:adapter-specialist@1";
const BASELINE_REF = "baseline:baseline@1";

describe("specialist task routing", () => {
  test("free guard skips general candidates without losing them and leaves pins unfiltered", async () => {
    const { router } = await adapterSetup();
    const first = await router.routeStep(context, {
      request: routingRequest(),
      free_target: (target) => target.kind === "baseline",
    });
    expect(first.step.selected?.ref).toBe(BASELINE_REF);
    expect(first.step.paid_skipped).toEqual([ADAPTER_REF]);
    expect(
      first.step.rejected.find((item) => item.ref === ADAPTER_REF)?.reasons,
    ).toContain("paid_skipped");
    expect(first.step.lost_refs).toEqual([]);
    const pinned = await router.routeStep(context, {
      request: routingRequest(),
      free_target: () => false,
    });
    expect(pinned.step.mode).toBe("pinned");
    expect(pinned.step.selected?.ref).toBe(BASELINE_REF);
    expect(pinned.step.paid_skipped).toEqual([]);
  });

  test("free guard exhaustion records skipped targets, absent guard adds no field", async () => {
    const { router } = await adapterSetup();
    const none = await router.routeStep(context, {
      request: routingRequest(),
      free_target: () => false,
    });
    expect(none.step.selected).toBeNull();
    expect(none.step.paid_skipped).toEqual([ADAPTER_REF, BASELINE_REF]);
    expect(none.step.lost_refs).toEqual([]);
    const unchanged = await router.routeStep(context, {
      request: routingRequest(),
    });
    expect(unchanged.step.selected?.ref).toBe(ADAPTER_REF);
    expect(unchanged.step).not.toHaveProperty("paid_skipped");
  });

  test("routes an attested in-budget adapter and keeps it pinned", async () => {
    const { router, registry, steps } = await adapterSetup();
    const first = await router.routeStep(context, {
      request: routingRequest(),
    });
    expect(first.step.mode).toBe("routed");
    expect(first.step.selected?.ref).toBe(ADAPTER_REF);
    expect(first.step.selected?.serving_attestation).toBe("verified");
    expect(first.state.pinned).toEqual({
      ref: ADAPTER_REF,
      via: "route",
      decision_id: first.step.decision_id as string,
    });
    const second = await router.routeStep(context, {
      request: routingRequest(),
      usage: { tokens: 100, usd: 0 },
    });
    expect(second.step).toMatchObject({
      step: 2,
      mode: "pinned",
      fallback_from: null,
      step_reasons: [],
      lost_refs: [],
      remaining: { tokens: 900, usd: 1, duration_ms: 1000 },
    });
    expect(second.step.selected?.ref).toBe(ADAPTER_REF);
    expect(steps.map((step) => step.mode)).toEqual(["routed", "pinned"]);
    const decision = (await registry.decision(
      context,
      second.step.decision_id as string,
    )) as RoutingDecision;
    expect(decision.override).toBe(true);
    expect(decision.selected?.ref).toBe(ADAPTER_REF);
    expect(
      (await registry.taskRoutingState(context, "route-task", "worker"))?.step,
    ).toBe(2);
  });

  test("falls back to the base model when serving becomes unattested mid-task", async () => {
    const { router, fake, steps } = await adapterSetup();
    await router.routeStep(context, { request: routingRequest() });
    fake.state.attested = false;
    const lost = await router.routeStep(context, { request: routingRequest() });
    expect(lost.step).toMatchObject({
      mode: "fallback",
      fallback_from: ADAPTER_REF,
      step_reasons: ["pinned_ineligible"],
      lost_refs: [ADAPTER_REF],
    });
    expect(lost.step.selected?.ref).toBe(BASELINE_REF);
    expect(lost.step.selected?.adapter_sha256).toBeNull();
    expect(
      lost.step.rejected.find((item) => item.ref === ADAPTER_REF)?.reasons,
    ).toContain("serving_unattested");
    expect(lost.state.pinned).toMatchObject({
      ref: BASELINE_REF,
      via: "fallback",
    });

    fake.state.attested = true;
    const later = await router.routeStep(context, {
      request: routingRequest(),
    });
    expect(later.step.mode).toBe("pinned");
    expect(later.step.selected?.ref).toBe(BASELINE_REF);
    expect(later.step.lost_refs).toEqual([ADAPTER_REF]);
    expect(steps.map((step) => [step.step, step.mode])).toEqual([
      [1, "routed"],
      [2, "fallback"],
      [3, "pinned"],
    ]);
  });

  test("a caller exclusion of the pin forces fallback", async () => {
    const { router } = await adapterSetup();
    await router.routeStep(context, { request: routingRequest() });
    const result = await router.routeStep(context, {
      request: routingRequest({
        exclude_refs: [ADAPTER_REF, "specialist:other@1"],
      }),
    });
    expect(result.step.mode).toBe("fallback");
    expect(result.step.selected?.ref).toBe(BASELINE_REF);
    expect(
      result.step.rejected.find((item) => item.ref === ADAPTER_REF)?.reasons,
    ).toContain("excluded");
  });

  test("a throwing attestor never yields an adapter route", async () => {
    const { router, fake } = await adapterSetup();
    fake.state.throws = true;
    const result = await router.routeStep(context, {
      request: routingRequest(),
    });
    expect(result.step.mode).toBe("fallback");
    expect(result.step.selected?.ref).toBe(BASELINE_REF);
    expect(
      result.step.rejected.find((item) => item.ref === ADAPTER_REF)?.reasons,
    ).toContain("serving_unattested");
  });

  test("an unattested registry has no path to the adapter", async () => {
    const { root, artifacts } = await adapterSetup();
    const unattested = createRegistry(root, artifacts);
    const router = new SpecialistTaskRouter(unattested);
    const result = await router.routeStep(context, {
      request: routingRequest({ task_id: "other-task" }),
    });
    expect(result.step.selected?.ref).toBe(BASELINE_REF);
    expect(result.step.fallback_from).toBe(ADAPTER_REF);
    expect(
      result.step.rejected.find((item) => item.ref === ADAPTER_REF)?.reasons,
    ).toContain("serving_unattested");
  });

  test("refuses an adapter target without verified attestation from any registry", async () => {
    const { registry } = await adapterSetup();
    const real = await registry.route(context, routingRequest());
    const forged = {
      ...real,
      selected: real.selected
        ? { ...real.selected, serving_attestation: "absent" as const }
        : null,
    } as RoutingDecision;
    const steps: TaskRoutingStep[] = [];
    const router = new SpecialistTaskRouter(
      {
        route: async () => forged,
        inspect: registry.inspect.bind(registry),
        fallbackChain: registry.fallbackChain.bind(registry),
        taskRoutingState: registry.taskRoutingState.bind(registry),
        commitTaskRoutingState: registry.commitTaskRoutingState.bind(registry),
      },
      { record: async (_context, step) => void steps.push(step) },
    );
    const result = await router.routeStep(context, {
      request: routingRequest({ task_id: "forged" }),
    });
    expect(result.step.mode).toBe("unavailable");
    expect(result.step.selected).toBeNull();
    expect(result.step.step_reasons).toEqual(["unattested_adapter_refused"]);
    expect(result.state.pinned).toBeNull();
    expect(result.state.lost_refs).toEqual([ADAPTER_REF]);
    expect(steps).toHaveLength(1);
  });

  test("a mid-task rollback routes later steps through fallback_specialist_revision", async () => {
    const { router, registry, artifacts, steps } = await setup();
    const v1 = await makeSpecialistFixture(artifacts, {
      specialistId: "lifecycle",
      revision: "1",
    });
    await registry.registerSpecialist(context, v1.registration);
    await registry.promote(context, "lifecycle", "1", null);
    const v2 = await makeSpecialistFixture(artifacts, {
      specialistId: "lifecycle",
      revision: "2",
      currentRevision: "1",
      fallbackRef: "specialist:lifecycle@1",
    });
    await registry.registerSpecialist(context, v2.registration);
    await registry.promote(context, "lifecycle", "2", "1");

    const first = await router.routeStep(context, {
      request: routingRequest(),
    });
    expect(first.step.selected?.ref).toBe("specialist:lifecycle@2");
    await registry.rollback(context, "lifecycle", "2");
    const second = await router.routeStep(context, {
      request: routingRequest(),
    });
    expect(second.step).toMatchObject({
      mode: "fallback",
      fallback_from: "specialist:lifecycle@2",
      step_reasons: ["pinned_rolled_back"],
      lost_refs: ["specialist:lifecycle@2"],
    });
    expect(second.step.selected?.ref).toBe("specialist:lifecycle@1");
    expect(
      second.step.rejected.find((item) => item.ref === "specialist:lifecycle@2")
        ?.reasons,
    ).toEqual(["pinned_rolled_back"]);

    await registry.retire(context, "lifecycle", "1");
    const third = await router.routeStep(context, {
      request: routingRequest(),
    });
    expect(third.step.mode).toBe("pinned");
    expect(third.step.selected?.ref).toBe("specialist:lifecycle@1");
    expect(steps.map((step) => step.mode)).toEqual([
      "routed",
      "fallback",
      "pinned",
    ]);
  });

  test("free guard skips a configured chain entry without marking it lost", async () => {
    const { router, registry, artifacts } = await setup();
    const v1 = await makeSpecialistFixture(artifacts, {
      specialistId: "chain",
      revision: "1",
    });
    await registry.registerSpecialist(context, v1.registration);
    await registry.promote(context, "chain", "1", null);
    const v2 = await makeSpecialistFixture(artifacts, {
      specialistId: "chain",
      revision: "2",
      currentRevision: "1",
      fallbackRef: "specialist:chain@1",
    });
    await registry.registerSpecialist(context, v2.registration);
    await registry.promote(context, "chain", "2", "1");
    await router.routeStep(context, { request: routingRequest() });
    await registry.rollback(context, "chain", "2");
    const result = await router.routeStep(context, {
      request: routingRequest(),
      free_target: (target) => target.kind === "baseline",
    });
    expect(result.step.selected?.ref).toBe(BASELINE_REF);
    expect(result.step.paid_skipped).toEqual(["specialist:chain@1"]);
    expect(result.step.rejected).toContainEqual({
      ref: "specialist:chain@1",
      reasons: ["paid_skipped"],
    });
    expect(result.step.lost_refs).toEqual(["specialist:chain@2"]);
  });

  test("workspace callers walk a project specialist's fallback chain", async () => {
    const { registry, artifacts } = await setup();
    const target = await makeSpecialistFixture(artifacts, {
      specialistId: "chain-target",
    });
    await registry.registerSpecialist(context, target.registration);
    const pinned = await makeSpecialistFixture(artifacts, {
      fallbackRef: "specialist:chain-target@1",
    });
    await registry.registerSpecialist(context, pinned.registration);
    await registry.promote(context, "specialist-1", "1", null);
    const workspace: RequestContext = {
      ...context,
      scope: { ...context.scope, workspace_id: "workspace-1" },
    };
    const router = new SpecialistTaskRouter(registry);
    const first = await router.routeStep(workspace, {
      request: routingRequest(),
    });
    expect(first.step.selected?.ref).toBe("specialist:specialist-1@1");
    await registry.retire(context, "specialist-1", "1");
    const second = await router.routeStep(workspace, {
      request: routingRequest(),
    });
    expect(second.step.step_reasons).toEqual(["pinned_retired"]);
    expect(second.step.selected?.ref).toBe("specialist:chain-target@1");
    await expect(
      registry.fallbackChain(workspace, "baseline:baseline@1", {
        ...context.scope,
        workspace_id: "workspace-2",
      }),
    ).rejects.toBeInstanceOf(SpecialistRegistryError);
  });

  test("budget pressure falls back and exhaustion stops routing", async () => {
    const { router, registry, artifacts } = await setup();
    const priced = await makeSpecialistFixture(artifacts, {
      specialistId: "priced",
      costUsdTotal: 0.5,
    });
    await registry.registerSpecialist(context, priced.registration);
    await registry.promote(context, "priced", "1", null);

    const first = await router.routeStep(context, {
      request: routingRequest(),
    });
    expect(first.step.selected?.ref).toBe("specialist:priced@1");
    const cost = first.step.selected?.evidence?.cost_usd_per_task ?? 0;
    expect(cost).toBeGreaterThan(0);

    const pressured = await router.routeStep(context, {
      request: routingRequest(),
      usage: { tokens: 10, usd: 1 - cost / 2 },
    });
    expect(pressured.step).toMatchObject({
      mode: "fallback",
      fallback_from: "specialist:priced@1",
      step_reasons: ["pinned_ineligible"],
    });
    expect(pressured.step.selected?.ref).toBe(BASELINE_REF);
    expect(
      pressured.step.rejected.find((item) => item.ref === "specialist:priced@1")
        ?.reasons,
    ).toContain("budget_cost_exceeded");

    const routedBefore = pressured.step.decision_id;
    const exhausted = await router.routeStep(context, {
      request: routingRequest(),
      usage: { tokens: 1000, usd: 1.5 },
    });
    expect(exhausted.step).toMatchObject({
      mode: "budget_exhausted",
      selected: null,
      decision_ids: [],
      decision_id: routedBefore,
      step_reasons: ["budget_tokens_exhausted", "budget_usd_exhausted"],
      remaining: { tokens: 0, usd: 0 },
    });
    expect(exhausted.state.pinned?.ref).toBe(BASELINE_REF);

    const late = await router.routeStep(context, {
      request: routingRequest(),
      deadline_at: Date.now() - 1,
    });
    expect(late.step.mode).toBe("budget_exhausted");
    expect(late.step.step_reasons).toEqual(["deadline_exhausted"]);
  });

  test("routes the remaining deadline and rejects overrides and bad usage", async () => {
    const { router, registry } = await setup();
    const now = 1_000_000;
    const timed = new SpecialistTaskRouter(registry, { now: () => now });
    const result = await timed.routeStep(context, {
      request: routingRequest(),
      deadline_at: now + 250,
    });
    expect(result.step.remaining.duration_ms).toBe(250);
    expect(result.step.selected?.ref).toBe(BASELINE_REF);
    for (const input of [
      { request: routingRequest({ override: { ref: BASELINE_REF } }) },
      { request: routingRequest(), usage: { tokens: -1, usd: 0 } },
      { request: routingRequest(), usage: { tokens: 0, usd: Number.NaN } },
    ]) {
      await expect(router.routeStep(context, input)).rejects.toBeInstanceOf(
        SpecialistRegistryError,
      );
    }
  });

  test("serializes concurrent steps and refuses a stale commit", async () => {
    const { router, registry } = await setup();
    const results = await Promise.all(
      [0, 1, 2].map(() =>
        router.routeStep(context, { request: routingRequest() }),
      ),
    );
    expect(results.map((item) => item.step.step).sort()).toEqual([1, 2, 3]);
    const state = await registry.taskRoutingState(
      context,
      "route-task",
      "worker",
    );
    expect(state?.step).toBe(3);
    const stale = { ...(state as NonNullable<typeof state>), step: 3 };
    try {
      await registry.commitTaskRoutingState(context, stale, 2);
      throw new Error("expected conflict");
    } catch (error) {
      expect((error as SpecialistRegistryError).code).toBe("conflict");
    }
    const other: RequestContext = {
      ...context,
      scope: { ...context.scope, project_id: "other-project" },
    };
    expect(
      await registry.taskRoutingState(other, "route-task", "worker"),
    ).toBeNull();
  });
});
