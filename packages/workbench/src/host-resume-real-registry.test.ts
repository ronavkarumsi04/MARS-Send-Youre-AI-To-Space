import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestContext, Task } from "@mars/contracts";
import {
  openRuntimeSession,
  type RuntimeSessionOptions,
} from "@mars/execution";
import { loadModelRegistry } from "@mars/providers";
import {
  type ServingAttestation,
  SpecialistRegistry,
  SpecialistTaskRouter,
  type TaskRoutingStep,
} from "@mars/specialists";
import { createTaskStore } from "@mars/tasks";
import { createLocalWorkspaceProvider } from "@mars/workspaces";
import {
  baseModel,
  evidenceVerifier,
  MemoryArtifacts,
  makeBaseline,
  makeLineageArtifact,
  makeSpecialistFixture,
  tokenizer,
} from "../../specialists/tests/helpers";
import { createWorkbenchHost } from "./host";
import type { Launch } from "./host-launch";
import type { WorkbenchSpecialists } from "./specialist-routing";

const scope = { owner_id: "owner", project_id: "project" };
const context = (): RequestContext => ({
  schema_version: 1,
  scope,
  request_id: randomUUID(),
});
const A = "fixture/a";
const B = "fixture/b";
const PIN = "specialist:multi@1";
const BASE = "baseline:baseline@1";
const cleanups: (() => Promise<void>)[] = [];
function required<T>(value: T | undefined | null): T {
  if (value == null) throw new Error("Required fixture value missing");
  return value;
}
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

type AttestationMode =
  | "verified"
  | "absent"
  | "unreachable"
  | "adapter_missing"
  | "base_mismatch"
  | "tokenizer_mismatch"
  | "template_mismatch"
  | "binding_mismatch"
  | "format_unsupported";

/**
 * Real registry, step router, task/artifact stores, local workspace and runtime.
 * Only the catalog, serving attestor, provider transport and router clock are
 * controlled. A length-limited offline response pauses the REAL runtime and
 * writes its journal; no router, routed step or runtime result is fabricated.
 */
async function fixture(
  options: {
    paidA?: boolean;
    paidB?: boolean;
    consent?: boolean;
    baseline?: boolean;
    chain?: boolean;
    chainPaid?: boolean;
    revision?: "1" | "2";
    reverse?: boolean;
    maxTokens?: number;
    prePauseHold?: { tokens: number; usd: number };
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "mars-real-registry-resume-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  await mkdir(source);
  await mkdir(join(root, "host"), { mode: 0o700 });
  await writeFile(join(source, "fixture.txt"), "offline source\n");
  const store = await createTaskStore({ rootDir: join(root, "tasks") });
  cleanups.push(() => store.close());
  const provider = await createLocalWorkspaceProvider({
    rootDir: join(root, "workspaces"),
    sourceRoot: source,
    artifacts: store.artifacts,
  });
  cleanups.push(() => provider.close());
  await mkdir(join(root, ".mars"));
  await writeFile(
    join(root, ".mars", "models.json"),
    JSON.stringify({
      version: 1,
      providers: [
        {
          id: "fixture",
          kind: "openai-compatible",
          baseUrl: "https://fixture.invalid/v1",
        },
      ],
      models: ["base", "a", "b", "paid-chain"].map((name) => ({
        id: `fixture/${name}`,
        providerId: "fixture",
        model: name,
        capabilities: { tools: true, vision: false, contextWindow: 32768 },
        pricing:
          (name === "a" && options.paidA) ||
          (name === "b" && options.paidB) ||
          name === "paid-chain"
            ? { free: false, inputPerMTokUsd: 1, outputPerMTokUsd: 1 }
            : { free: true },
      })),
      routes: { default: ["fixture/base"] },
      policy: { allowPaid: true },
    }),
  );
  const catalog = await loadModelRegistry({ cwd: root, home: root, env: {} });
  const template = await store.artifacts.put(
    context(),
    new TextEncoder().encode("template"),
    "text/plain",
  );
  const adapter = await store.artifacts.put(
    context(),
    new Uint8Array([1, 2, 3]),
    "application/octet-stream",
  );
  // Helpers manufacture signed fixture documents; the registry reads all of
  // their bytes from the real durable artifact store, never MemoryArtifacts.
  const documents = new MemoryArtifacts();
  const lineageRef = await makeLineageArtifact(documents, scope, {
    specialistId: "multi",
  });
  const lineage = await store.artifacts.put(
    context(),
    await documents.get(context(), lineageRef),
    "application/json",
  );
  const modes = new Map<string, AttestationMode>([
    [A, "verified"],
    [B, "verified"],
  ]);
  const calls: string[] = [];
  const registry = new SpecialistRegistry({
    rootDir: join(root, "specialists"),
    artifacts: store.artifacts,
    catalog,
    allowSyntheticFixtures: true,
    evidenceVerifier: evidenceVerifier({ ownerIds: [scope.owner_id] }),
    servingAttestor: {
      async attest(_ctx, binding) {
        calls.push(binding.model_id);
        const mode = modes.get(binding.model_id) ?? "absent";
        if (mode === "unreachable")
          throw new Error("offline serving host unreachable");
        if (mode === "absent") return null;
        const attestation: ServingAttestation = {
          ...binding,
          base_model: baseModel,
          tokenizer,
          chat_template_sha256: template.sha256,
          adapter_formats: ["peft-lora"],
          loaded_adapter_sha256s: [adapter.sha256],
        };
        if (mode === "adapter_missing") attestation.loaded_adapter_sha256s = [];
        if (mode === "base_mismatch")
          attestation.base_model = { ...baseModel, revision: "other" };
        if (mode === "tokenizer_mismatch")
          attestation.tokenizer = { ...tokenizer, revision: "other" };
        if (mode === "template_mismatch")
          attestation.chat_template_sha256 = "f".repeat(64);
        if (mode === "binding_mismatch") attestation.model_id = "fixture/other";
        if (mode === "format_unsupported") attestation.adapter_formats = [];
        return attestation;
      },
    },
  });
  cleanups.push(async () => registry.close());
  await registry.registerBaseline(
    context(),
    makeBaseline(scope, {
      model_id: "fixture/base",
      provider_id: "fixture",
      provider_model: "base",
      ...(options.baseline === false ? { roles: ["reviewer"] } : {}),
    }),
  );
  if (options.chain) {
    const fallback = await makeSpecialistFixture(documents, {
      scope,
      specialistId: "chain",
      modelId: options.chainPaid ? "fixture/paid-chain" : "fixture/base",
      providerId: "fixture",
      providerModel: options.chainPaid ? "paid-chain" : "base",
    });
    fallback.registration.evaluation = await store.artifacts.put(
      context(),
      fallback.reportBytes,
      "application/json",
    );
    await registry.registerSpecialist(context(), fallback.registration);
    // A configured chain can use an evaluated, unpromoted revision; it must
    // not win the initial production route ahead of our multi-binding pin.
  }
  const serving = [A, B].map((id) => ({
    model_id: id,
    provider_id: "fixture",
    provider_model: id.slice("fixture/".length),
    adapter_format: "peft-lora" as const,
  }));
  if (options.reverse) serving.reverse();
  const register = async (revision: string, previous: string | null) => {
    const candidate = await makeSpecialistFixture(documents, {
      scope,
      specialistId: "multi",
      revision,
      currentRevision: previous,
      serving,
      adapter,
      chatTemplate: template,
      datasetLineage: lineage,
      adapterSpec: {
        format: "peft-lora",
        base_model: baseModel,
        tokenizer,
        chat_template_sha256: template.sha256,
      },
      ...(options.chain ? { fallbackRef: "specialist:chain@1" } : {}),
    });
    candidate.registration.evaluation = await store.artifacts.put(
      context(),
      candidate.reportBytes,
      "application/json",
    );
    await registry.registerSpecialist(context(), candidate.registration);
    await registry.promote(context(), "multi", revision, previous);
  };
  await register("1", null);
  if (options.revision === "2") await register("2", "1");
  const steps: TaskRoutingStep[] = [];
  const clock: { now?: number } = {};
  const specialists: WorkbenchSpecialists = {
    router: registry,
    steps: new SpecialistTaskRouter(registry, {
      now: () => clock.now ?? Date.now(),
      record: async (_ctx, step) => {
        steps.push(step);
      },
    }),
    domain: "coding/mechanical-edit",
    paid_consent: options.consent ?? true,
  };
  const sessions: {
    options: RuntimeSessionOptions;
    journal: string;
    disposed: Promise<void>;
  }[] = [];
  const requests: { model: string; messages: unknown[] }[] = [];
  const makeHost = () =>
    createWorkbenchHost({
      scope,
      workspaceLabel: "offline source",
      canExecute: false,
      stateRoot: join(root, "host"),
      store,
      registry: catalog,
      specialists,
      workspace: {
        prepare: provider.prepare.bind(provider),
        read: provider.read.bind(provider),
        write: provider.write.bind(provider),
        remove: provider.remove.bind(provider),
        execute: provider.execute.bind(provider),
        checkpoint: provider.checkpoint.bind(provider),
        restore: provider.restore.bind(provider),
        collect: provider.collect.bind(provider),
        stop: provider.stop.bind(provider),
        diff: provider.diff.bind(provider),
        cwd: provider.workspacePath.bind(provider),
        async reopen(ctx, taskId) {
          const workspace = await provider.discover(ctx, taskId);
          if (!workspace) throw new Error("workspace missing");
          return workspace;
        },
      },
      async runtimeFactory(runtimeOptions) {
        let disposed!: () => void;
        const done = new Promise<void>((resolve) => {
          disposed = resolve;
        });
        const runtime = await openRuntimeSession({
          ...runtimeOptions,
          async fetch(_url, init) {
            requests.push(JSON.parse(String(init?.body)));
            if (requests.length === 1 && options.prePauseHold) {
              await required(store.reserveBudget)(
                context(),
                "task",
                "background",
                options.prePauseHold,
              );
            }
            // The provider returns length, so the real runtime pauses naturally.
            return new Response(
              [
                `data: ${JSON.stringify({ choices: [{ delta: { content: `Offline turn ${requests.length}` }, finish_reason: null }] })}\n\n`,
                `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 50, completion_tokens: 12 } })}\n\n`,
                "data: [DONE]\n\n",
              ].join(""),
              { headers: { "content-type": "text/event-stream" } },
            );
          },
        });
        sessions.push({
          options: runtimeOptions,
          journal: runtime.journalPath,
          disposed: done,
        });
        return {
          ...runtime,
          async dispose() {
            try {
              await runtime.dispose();
            } finally {
              disposed();
            }
          },
        };
      },
    });
  let api = await makeHost();
  cleanups.push(() => api.close());
  const input: Task = {
    schema_version: 1,
    scope,
    task_id: "task",
    session_id: "session",
    revision: 0,
    request: "Write a fixture",
    acceptance_criteria: ["Keep the saved conversation"],
    budget: {
      max_tokens: options.maxTokens ?? 64000,
      max_usd: 1,
      max_duration_ms: 120000,
      max_depth: 1,
      max_concurrency: 1,
    },
    status: "pending",
    specialist_revision: null,
    artifacts: [],
  };
  await api.create(context(), input);
  await api.start(context(), {
    task_id: "task",
    expected_revision: 0,
    approvals: { read: true, write: false, execute: false },
  });
  await sessions[0]?.disposed;
  expect((await api.inspect(context(), "task")).status).toBe("paused");
  expect(sessions[0]?.options.modelId).toBe(options.reverse ? B : A);
  const launchPath = join(
    required(sessions[0]).options.stateDir,
    "launch.json",
  );
  const launch = async (): Promise<Launch> =>
    JSON.parse(await readFile(launchPath, "utf8"));
  const routingEvents = async () => {
    const events: Record<string, unknown>[] = [];
    for await (const event of store.events(context(), "task")) {
      const payload = JSON.parse(
        new TextDecoder().decode(
          await store.artifacts.get(context(), event.payload),
        ),
      );
      if (payload.operation === "routing") events.push(payload);
    }
    return events;
  };
  const resume = async () => {
    const count = sessions.length;
    await api.resume(
      context(),
      "task",
      (await api.inspect(context(), "task")).revision,
    );
    expect(sessions).toHaveLength(count + 1);
    await sessions[count]?.disposed;
    expect((await api.inspect(context(), "task")).status).toBe("paused");
  };
  const restart = async () => {
    await api.close();
    api = await makeHost();
  };
  return {
    root,
    store,
    registry,
    catalog,
    modes,
    calls,
    steps,
    clock,
    specialists,
    sessions,
    requests,
    launch,
    resume,
    routingEvents,
    register,
    restart,
    api: () => api,
  };
}

async function assertRebound(
  f: Awaited<ReturnType<typeof fixture>>,
  from = A,
  to = B,
  ref = PIN,
) {
  const last = required(f.sessions.at(-1));
  expect(last.options.modelId).toBe(to);
  expect(last.options.sessionFile).toBe(f.sessions[0]?.journal);
  expect(last.options.deadline).toBe(f.sessions[0]?.options.deadline);
  expect(last.options.rebindFromModelIds).toContain(from);
  expect((await f.api().inspect(context(), "task")).specialist_revision).toBe(
    ref,
  );
  const launch = await f.launch();
  expect(launch.model_rebinds?.at(-1)).toMatchObject({
    from_model_id: from,
    to_model_id: to,
    from_ref: ref,
    to_ref: ref,
    step_reasons: [],
  });
  const event = (await f.routingEvents()).at(-1);
  expect(event).toMatchObject({
    status: "pinned",
    ref,
    lost_refs: [],
    resume: {
      action: "rebound",
      reason: "pinned_binding_changed",
      from_model_id: from,
      to_model_id: to,
    },
  });
  const decision = await f.registry.decision(
    context(),
    required(launch.routing).decision_id,
  );
  expect(decision.selected).toMatchObject({
    ref,
    model_id: to,
    serving_attestation: "verified",
  });
  const journal = (await readFile(last.journal, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    journal.filter((entry) => entry.customType === "mars.model_rebind").at(-1)
      ?.data,
  ).toEqual({ from_model_id: from, to_model_id: to });
  expect(
    journal.filter((entry) => entry.customType === "mars.binding").at(-1)?.data
      .model_id,
  ).toBe(to);
  expect(JSON.stringify(f.requests.at(-1)?.messages)).toContain(
    "Offline turn 1",
  );
}

test.each([
  "absent",
  "unreachable",
  "adapter_missing",
  "base_mismatch",
  "tokenizer_mismatch",
  "template_mismatch",
  "binding_mismatch",
  "format_unsupported",
] as const)(
  "real registry resume swaps the same pin after first binding becomes %s",
  async (mode) => {
    const f = await fixture();
    f.modes.set(A, mode);
    await f.resume();
    await assertRebound(f);
    expect((await f.launch()).model_rebinds).toHaveLength(1);
    expect(f.steps.at(-1)?.selected?.adapter_sha256).not.toBeNull();
  },
  30000,
);

test.each([
  "model_missing",
  "catalog_binding_changed",
  "tools_removed",
  "context_shrunk",
] as const)(
  "real registry resume swaps after catalog change: %s",
  async (change) => {
    const f = await fixture();
    const model = required(f.catalog.getModel(A));
    if (change === "model_missing")
      f.catalog.models.splice(f.catalog.models.indexOf(model), 1);
    if (change === "catalog_binding_changed")
      model.model = "different-upstream";
    if (change === "tools_removed") model.capabilities.tools = false;
    if (change === "context_shrunk") model.capabilities.contextWindow = 1;
    await f.resume();
    await assertRebound(f);
  },
  30000,
);

test.each([false, true])(
  "real registry binding order is deterministic (reversed=%s) and swaps back",
  async (reverse) => {
    const f = await fixture({ reverse });
    const first = reverse ? B : A;
    const second = reverse ? A : B;
    await f.resume();
    expect(f.steps.at(-1)?.selected?.model_id).toBe(first);
    expect((await f.launch()).model_rebinds).toBeUndefined();
    f.modes.set(first, "absent");
    await f.resume();
    await assertRebound(f, first, second);
    f.modes.set(first, "verified");
    // Both now pass again: profile order, not the last serving model, wins.
    await f.resume();
    await assertRebound(f, second, first);
    expect((await f.launch()).model_rebinds).toHaveLength(2);
    await f.restart();
    await f.resume();
    expect(f.steps.at(-1)?.selected?.model_id).toBe(first);
    expect((await f.launch()).model_rebinds).toHaveLength(2);
  },
  30000,
);

test.each(["base", "chain", "unavailable"] as const)(
  "real registry with no attested binding resumes to %s",
  async (target) => {
    const f = await fixture({
      chain: target === "chain",
      baseline: target !== "unavailable",
    });
    f.modes.set(A, "absent");
    f.modes.set(B, "unreachable");
    const before = await f.launch();
    if (target === "unavailable") {
      await expect(f.resume()).rejects.toMatchObject({ code: "unavailable" });
      expect(f.sessions).toHaveLength(1);
      expect(await f.launch()).toEqual(before);
      expect(f.steps.at(-1)).toMatchObject({
        mode: "unavailable",
        selected: null,
        lost_refs: [PIN],
      });
      expect((await f.routingEvents()).at(-1)).toMatchObject({
        resume: { action: "refused", reason: "routing_unavailable" },
      });
    } else {
      await f.resume();
      const ref = target === "chain" ? "specialist:chain@1" : BASE;
      expect(f.steps.at(-1)).toMatchObject({
        mode: "fallback",
        selected: { ref, model_id: "fixture/base" },
        lost_refs: [PIN],
      });
      expect((await f.routingEvents()).at(-1)).toMatchObject({
        resume: {
          action: "fallback",
          reason: "serving_unattested",
          to_ref: ref,
        },
      });
      expect(
        (await f.api().inspect(context(), "task")).specialist_revision,
      ).toBe(target === "chain" ? ref : null);
      expect((await f.launch()).model_rebinds).toHaveLength(1);
    }
    expect(
      f.steps.at(-1)?.rejected.find((item) => item.ref === PIN)?.reasons,
    ).toContain("serving_unattested");
    expect((await f.api().inspect(context(), "task")).status).toBe("paused");
  },
  30000,
);

test("real registry never selects the new adapter binding without attestation", async () => {
  const f = await fixture();
  f.modes.set(A, "adapter_missing");
  f.modes.set(B, "absent");
  await f.resume();
  expect(f.steps.at(-1)?.selected).toMatchObject({
    kind: "baseline",
    ref: BASE,
    adapter_sha256: null,
  });
  expect(
    f.steps.at(-1)?.rejected.find((item) => item.ref === PIN)?.reasons,
  ).toEqual(["serving_adapter_not_loaded", "serving_unattested"]);
  expect((await f.routingEvents()).at(-1)).toMatchObject({
    resume: { action: "fallback", reason: "serving_adapter_not_loaded" },
  });
  expect((await f.launch()).model_rebinds?.at(-1)?.to_model_id).toBe(
    "fixture/base",
  );
}, 30000);

test("real registry paid binding is refused for a free launch even with current paid consent", async () => {
  const f = await fixture({ paidB: true });
  f.modes.set(A, "absent");
  const before = await f.launch();
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(f.resume()).rejects.toMatchObject({ code: "unavailable" });
    expect(f.steps.at(-1)).toMatchObject({
      mode: "pinned",
      selected: { ref: PIN, model_id: B },
      paid_skipped: [],
      lost_refs: [],
    });
    expect((await f.routingEvents()).at(-1)).toMatchObject({
      resume: { action: "refused", reason: "fallback_paid_refused" },
    });
    expect(await f.launch()).toEqual(before);
    expect(f.sessions).toHaveLength(1);
  }
  // A refused step keeps the same ref and can recover without poisoning it.
  f.modes.set(A, "verified");
  await f.resume();
  expect((await f.launch()).model_rebinds).toBeUndefined();
  expect(f.sessions.at(-1)?.options.modelId).toBe(A);
}, 30000);

test.each([false, true])(
  "real registry paid launch changes to paid binding with current consent=%s",
  async (consent) => {
    const f = await fixture({ paidA: true, paidB: true });
    f.modes.set(A, "absent");
    f.specialists.paid_consent = consent;
    await f.restart();
    await f.resume();
    if (consent) {
      await assertRebound(f);
    } else {
      // The registry rejects B before the host guard: this is a baseline
      // fallback, not the stub-only same-pin/paid-refusal combination.
      expect(f.steps.at(-1)?.selected).toMatchObject({ ref: BASE });
      expect(
        f.steps.at(-1)?.rejected.find((item) => item.ref === PIN)?.reasons,
      ).toContain("paid_consent_missing");
      expect((await f.routingEvents()).at(-1)).toMatchObject({
        resume: { action: "fallback", reason: "serving_unattested" },
      });
      expect(f.sessions.at(-1)?.options.modelId).toBe("fixture/base");
    }
  },
  30000,
);

test("real registry rejects a paid replacement before selection when a free launch has no consent", async () => {
  const f = await fixture({ paidB: true, consent: false });
  f.modes.set(A, "absent");
  await f.resume();
  expect(f.steps.at(-1)).toMatchObject({
    mode: "fallback",
    selected: { ref: BASE },
  });
  expect(
    f.steps.at(-1)?.rejected.find((item) => item.ref === PIN)?.reasons,
  ).toContain("paid_consent_missing");
  expect((await f.routingEvents()).at(-1)).toMatchObject({
    resume: { action: "fallback", reason: "serving_unattested" },
  });
}, 30000);

test("real registry keeps a paid launch paused when consent is withdrawn and no base can route", async () => {
  const f = await fixture({ paidA: true, paidB: true, baseline: false });
  f.specialists.paid_consent = false;
  f.modes.set(A, "absent");
  const before = await f.launch();
  await expect(f.resume()).rejects.toMatchObject({ code: "unavailable" });
  expect(f.steps.at(-1)).toMatchObject({ mode: "unavailable", selected: null });
  expect(
    f.steps.at(-1)?.rejected.find((item) => item.ref === PIN)?.reasons,
  ).toContain("paid_consent_missing");
  expect((await f.routingEvents()).at(-1)).toMatchObject({
    resume: { action: "refused", reason: "routing_unavailable" },
  });
  expect(await f.launch()).toEqual(before);
  expect(f.sessions).toHaveLength(1);
  expect((await f.api().inspect(context(), "task")).status).toBe("paused");
}, 30000);

test.each(["free-base", "no-free-target", "paid-launch"] as const)(
  "real multi-binding pin loses all bindings with a paid fallback: %s",
  async (policy) => {
    const f = await fixture({
      chain: true,
      chainPaid: true,
      paidA: policy === "paid-launch",
      baseline: policy !== "no-free-target",
    });
    f.modes.set(A, "absent");
    f.modes.set(B, "absent");
    const before = await f.launch();
    if (policy === "no-free-target") {
      await expect(f.resume()).rejects.toMatchObject({ code: "unavailable" });
      expect(await f.launch()).toEqual(before);
      expect(f.sessions).toHaveLength(1);
      expect((await f.api().inspect(context(), "task")).status).toBe("paused");
      expect((await f.routingEvents()).at(-1)).toMatchObject({
        resume: { action: "refused", reason: "fallback_paid_refused" },
      });
    } else {
      await f.resume();
      expect(f.sessions.at(-1)?.options.modelId).toBe(
        policy === "paid-launch" ? "fixture/paid-chain" : "fixture/base",
      );
      expect((await f.routingEvents()).at(-1)).toMatchObject({
        resume: {
          action: "fallback",
          reason:
            policy === "paid-launch"
              ? "serving_unattested"
              : "fallback_paid_skipped",
        },
      });
      expect((await f.launch()).model_rebinds).toHaveLength(1);
    }
    if (policy !== "paid-launch") {
      expect(f.steps.at(-1)?.paid_skipped).toEqual(["specialist:chain@1"]);
      expect(f.steps.at(-1)?.lost_refs).toEqual([PIN]);
      expect(f.steps.at(-1)?.rejected).toContainEqual({
        ref: "specialist:chain@1",
        reasons:
          policy === "no-free-target"
            ? ["excluded", "paid_skipped"]
            : ["paid_skipped"],
      });
    }
  },
  30000,
);

test("real registry keeps the task paused when both bindings lose tool capability", async () => {
  const f = await fixture();
  for (const modelId of [A, B])
    required(f.catalog.getModel(modelId)).capabilities.tools = false;
  const before = await f.launch();
  await expect(f.resume()).rejects.toMatchObject({ code: "unavailable" });
  expect(f.steps.at(-1)).toMatchObject({
    mode: "fallback",
    selected: { ref: BASE },
    rejected: [{ ref: PIN, reasons: ["capability_tools"] }],
  });
  expect((await f.routingEvents()).at(-1)).toMatchObject({
    resume: { action: "refused", reason: "pinned_not_invalidated" },
  });
  expect(await f.launch()).toEqual(before);
  expect(f.sessions).toHaveLength(1);
  expect((await f.api().inspect(context(), "task")).status).toBe("paused");
}, 30000);

test.each(["rollback", "supersede", "retire"] as const)(
  "real registry lifecycle %s wins over a simultaneous binding swap",
  async (change) => {
    const f = await fixture({ revision: change === "rollback" ? "2" : "1" });
    const pinned = `specialist:multi@${change === "rollback" ? "2" : "1"}`;
    if (change === "supersede") await f.register("2", "1");
    if (change === "rollback")
      await f.registry.rollback(context(), "multi", "2");
    if (change === "retire") await f.registry.retire(context(), "multi", "1");
    f.modes.set(A, "absent");
    await f.resume();
    const reason =
      change === "rollback"
        ? "pinned_rolled_back"
        : change === "supersede"
          ? "pinned_superseded"
          : "pinned_retired";
    expect(f.steps.at(-1)).toMatchObject({
      mode: "fallback",
      selected: { ref: BASE },
      lost_refs: [pinned],
      step_reasons: [reason],
    });
    expect((await f.routingEvents()).at(-1)).toMatchObject({
      resume: { action: "fallback", reason, from_ref: pinned, to_ref: BASE },
    });
    expect(
      (await f.api().inspect(context(), "task")).specialist_revision,
    ).toBeNull();
  },
  30000,
);

test("real registry allows 32 actual journal rebinds and refuses the 33rd", async () => {
  const f = await fixture({ maxTokens: 640000 });
  for (let count = 1; count <= 32; count++) {
    const from = count % 2 ? A : B;
    const to = count % 2 ? B : A;
    f.modes.set(from, "absent");
    f.modes.set(to, "verified");
    await f.resume();
    await assertRebound(f, from, to);
    expect((await f.launch()).model_rebinds).toHaveLength(count);
  }
  // Reaching the cap restricts further changes, not an unchanged kept pin.
  await f.resume();
  expect((await f.launch()).model_rebinds).toHaveLength(32);
  expect((await f.routingEvents()).at(-1)).toMatchObject({
    resume: { action: "pinned", reason: null, to_model_id: A },
  });
  const before = await f.launch();
  f.modes.set(A, "absent");
  f.modes.set(B, "verified");
  await f.restart();
  await expect(f.resume()).rejects.toMatchObject({ code: "unavailable" });
  expect(await f.launch()).toEqual(before);
  expect(f.sessions).toHaveLength(34);
  expect((await f.routingEvents()).at(-1)).toMatchObject({
    resume: { action: "refused", reason: "rebind_limit_reached" },
  });
  const journal = await readFile(required(f.sessions[0]).journal, "utf8");
  expect(journal.split('"customType":"mars.model_rebind"').length - 1).toBe(32);
}, 120000);

test("real registry rebind preserves pre-pause holds, durable usage and the journal deadline across host restart", async () => {
  const f = await fixture({ prePauseHold: { tokens: 1000, usd: 0.25 } });
  const committed = await required(f.store.budgetCommitted)(context(), "task");
  const before = await f.api().inspect(context(), "task");
  const deadline = required((await f.launch()).deadline);
  f.clock.now = deadline - 500;
  f.modes.set(A, "absent");
  await f.restart();
  await f.resume();
  await assertRebound(f);
  expect(f.steps.at(-1)?.remaining).toEqual({
    tokens: 64000 - committed.tokens,
    usd: 1 - committed.usd,
    duration_ms: 500,
  });
  expect((await f.launch()).deadline).toBe(deadline);
  const after = await f.api().inspect(context(), "task");
  expect(required(after.usage_totals).input_tokens).toBe(
    required(before.usage_totals).input_tokens + 50,
  );
  expect(required(after.usage_totals).output_tokens).toBe(
    required(before.usage_totals).output_tokens + 12,
  );
  const afterCommitted = await required(f.store.budgetCommitted)(
    context(),
    "task",
  );
  expect(afterCommitted.tokens).toBeGreaterThan(committed.tokens);
  expect(afterCommitted.usd).toBe(committed.usd);
  f.clock.now = deadline + 1;
  const saved = await f.launch();
  await expect(f.resume()).rejects.toMatchObject({ code: "unavailable" });
  expect(await f.launch()).toEqual(saved);
  expect(f.steps.at(-1)).toMatchObject({
    mode: "budget_exhausted",
    step_reasons: ["deadline_exhausted"],
  });
  expect((await f.routingEvents()).at(-1)).toMatchObject({
    resume: { action: "refused", reason: "budget_exhausted" },
  });
}, 30000);

test.each(["tokens", "cost", "runtime"] as const)(
  "real registry no binding can escape exhausted %s budget",
  async (kind) => {
    const f = await fixture();
    const committed = await required(f.store.budgetCommitted)(
      context(),
      "task",
    );
    if (kind === "tokens")
      await required(f.store.reserveBudget)(context(), "task", "background", {
        tokens: 64000 - committed.tokens,
        usd: 0,
      });
    if (kind === "cost")
      await required(f.store.reserveBudget)(context(), "task", "background", {
        tokens: 0,
        usd: 1 - committed.usd,
      });
    if (kind === "runtime")
      f.clock.now = required((await f.launch()).deadline) - 50;
    const before = await f.launch();
    await expect(f.resume()).rejects.toMatchObject({ code: "unavailable" });
    expect(await f.launch()).toEqual(before);
    expect(f.sessions).toHaveLength(1);
    expect((await f.api().inspect(context(), "task")).status).toBe("paused");
    if (kind === "tokens") {
      expect(f.steps.at(-1)).toMatchObject({
        mode: "budget_exhausted",
        step_reasons: ["budget_tokens_exhausted"],
      });
      expect((await f.routingEvents()).at(-1)).toMatchObject({
        resume: { action: "refused", reason: "budget_exhausted" },
      });
    } else {
      // Measured cost/runtime belongs to the revision's coverage triple, not
      // an individual binding. Even healthy B fails the same remaining budget.
      const reason =
        kind === "cost" ? "budget_cost_exceeded" : "budget_runtime_exceeded";
      expect(f.steps.at(-1)?.selected?.ref).toBe(BASE);
      expect(
        f.steps.at(-1)?.rejected.find((item) => item.ref === PIN)?.reasons,
      ).toContain(reason);
      expect((await f.routingEvents()).at(-1)).toMatchObject({
        resume: { action: "refused", reason: "pinned_not_invalidated" },
      });
    }
  },
  30000,
);
