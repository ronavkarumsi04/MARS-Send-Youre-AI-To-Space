import { afterEach, describe, expect, test } from "bun:test";
import {
  type ModelCatalog,
  SpecialistTaskRouter,
  type TaskRoutingStep,
} from "@mars/specialists";
import {
  artifactRef,
  baseModel,
  context,
  createRegistry,
  createTempRoot,
  fakeCatalog,
  MemoryArtifacts,
  makeBaseline,
  makeLineageArtifact,
  makeSpecialistFixture,
  removeTempRoot,
  routingRequest,
  tokenizer,
} from "../../specialists/tests/helpers";
import {
  createVllmServingAttestor,
  type FakeVllm,
  startFakeVllm,
  VllmClient,
  type VllmServingProfile,
  vllmCatalog,
} from "./index";

// A (vLLM attestor) feeding B (task router) end to end, against the fake
// vLLM HTTP server: no stubbed attestor in between.
const adapter = artifactRef("vllm-adapter-bytes", new Uint8Array([7, 7, 7]));
const chatTemplate = artifactRef("vllm-chat-template");
const profile: VllmServingProfile = {
  schema_version: 1,
  served_model_name: "mars-base",
  model_path: "/models/mars-base",
  base_model: baseModel,
  tokenizer,
  chat_template_sha256: chatTemplate.sha256,
  capabilities: { tools: true, vision: false },
  max_lora_rank: 16,
};
const SPECIALIST_REF = "specialist:vllm-specialist@1";
const BASELINE_REF = "baseline:baseline@1";

const servers: FakeVllm[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    expect(server.modelRequests()).toEqual([]);
    await server.stop();
  }
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

function catalog(): ModelCatalog {
  const vllm = vllmCatalog(profile);
  const local = fakeCatalog();
  return {
    policy: { allowPaid: false },
    getModel: (id) => vllm.getModel(id) ?? local.getModel(id),
    unavailableReason: (providerId) => local.unavailableReason(providerId),
  };
}

async function setup(server: FakeVllm) {
  const root = await createTempRoot();
  roots.push(root);
  const artifacts = new MemoryArtifacts();
  const registry = createRegistry(root, artifacts, {
    catalog: catalog(),
    servingAttestor: createVllmServingAttestor({
      client: new VllmClient({ url: server.url, timeoutMs: 500 }),
      profile,
    }),
  });
  await registry.registerBaseline(context, makeBaseline());
  const fixture = await makeSpecialistFixture(artifacts, {
    specialistId: "vllm-specialist",
    adapter,
    adapterFormat: "peft-lora",
    adapterSpec: {
      format: "peft-lora",
      base_model: baseModel,
      tokenizer,
      chat_template_sha256: chatTemplate.sha256,
    },
    chatTemplate,
    datasetLineage: await makeLineageArtifact(artifacts, context.scope, {
      specialistId: "vllm-specialist",
    }),
    serving: [
      {
        model_id: `vllm/${adapter.sha256}`,
        provider_id: "vllm",
        provider_model: adapter.sha256,
        adapter_format: "peft-lora",
      },
    ],
  });
  await registry.registerSpecialist(context, fixture.registration);
  await registry.promote(context, "vllm-specialist", "1", null);
  const steps: TaskRoutingStep[] = [];
  const router = new SpecialistTaskRouter(registry, {
    record: async (_context, step) => {
      steps.push(step);
    },
  });
  return { registry, router, steps };
}

function fake(): FakeVllm {
  const server = startFakeVllm({
    baseName: profile.served_model_name,
    baseRoot: profile.model_path as string,
    adapters: { [adapter.sha256]: "/srv/mars/adapters/a" },
  });
  servers.push(server);
  return server;
}

function rejectedReasons(step: TaskRoutingStep): string[] {
  return (
    step.rejected.find((item) => item.ref === SPECIALIST_REF)?.reasons ?? []
  );
}

describe("vLLM attestor → specialist task router", () => {
  test("routes the loaded adapter, then falls back when vLLM unloads it", async () => {
    const server = fake();
    const { router, steps } = await setup(server);
    const first = await router.routeStep(context, {
      request: routingRequest(),
    });
    expect(first.step.mode).toBe("routed");
    expect(first.step.selected).toMatchObject({
      ref: SPECIALIST_REF,
      serving_attestation: "verified",
      adapter_sha256: adapter.sha256,
    });

    server.state.adapters.delete(adapter.sha256);
    const lost = await router.routeStep(context, {
      request: routingRequest(),
    });
    expect(lost.step).toMatchObject({
      mode: "fallback",
      fallback_from: SPECIALIST_REF,
      lost_refs: [SPECIALIST_REF],
    });
    expect(lost.step.selected?.ref).toBe(BASELINE_REF);
    expect(lost.step.selected?.adapter_sha256).toBeNull();
    expect(rejectedReasons(lost.step)).toContain("serving_adapter_not_loaded");
    expect(steps.map((step) => step.mode)).toEqual(["routed", "fallback"]);
  });

  test("a version-mismatched or unreachable vLLM never yields an adapter route", async () => {
    const mismatched = fake();
    const { router } = await setup(mismatched);
    mismatched.state.version = "0.31.0";
    const step = await router.routeStep(context, {
      request: routingRequest(),
    });
    expect(step.step.selected?.ref).toBe(BASELINE_REF);
    expect(step.step.selected?.adapter_sha256).toBeNull();
    expect(rejectedReasons(step.step)).toContain("serving_unattested");

    const gone = fake();
    const offline = await setup(gone);
    await gone.stop();
    const unreachable = await offline.router.routeStep(context, {
      request: routingRequest(),
    });
    expect(unreachable.step.selected?.ref).toBe(BASELINE_REF);
    expect(rejectedReasons(unreachable.step)).toContain("serving_unattested");
  });
});
