import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RequestContext } from "@mars/contracts";
import { loadModelRegistry } from "@mars/providers";
import {
  checkServingReadiness,
  type ModelCatalog,
  type ReasonCode,
  type ServingBinding,
  type SpecialistRegistration,
} from "@mars/specialists";
import {
  type AdapterArtifact,
  createVllmServingAttestor,
  extendRegistryWithVllm,
  type FakeVllm,
  readVllmServing,
  startFakeVllm,
  VLLM_PIN,
  VllmAdapterManager,
  VllmAdapterRefused,
  VllmClient,
  type VllmServingProfile,
  versionMatchesPin,
  vllmCatalog,
  vllmModels,
  vllmOrigin,
  vllmProvider,
  vllmServeArgv,
} from "./index";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const ADAPTER = sha("adapter-bundle-1");
const ADAPTER_2 = sha("adapter-bundle-2");
const TEMPLATE = sha("chat-template");
const context: RequestContext = {
  schema_version: 1,
  scope: { owner_id: "owner", project_id: "project" },
  request_id: "vllm-test",
};
const profile: VllmServingProfile = {
  schema_version: 1,
  served_model_name: "mars-base",
  model_path: "/models/mars-base",
  base_model: { component: "model/qwen", revision: "rev-1" },
  tokenizer: { component: "tokenizer/qwen", revision: "rev-1" },
  chat_template_sha256: TEMPLATE,
  capabilities: { tools: true, vision: false },
  max_lora_rank: 16,
};
const artifact = (digest: string): AdapterArtifact => ({
  sha256: digest,
  path: `/srv/mars/adapters/${digest}`,
});

function registration(
  overrides: {
    adapter?: string | null;
    base?: string;
    tokenizer?: string;
    template?: string;
    bindings?: ServingBinding[];
    format?: "peft-lora" | null;
  } = {},
): SpecialistRegistration {
  const adapter = overrides.adapter === undefined ? ADAPTER : overrides.adapter;
  const ref = (digest: string) => ({
    artifact_id: `artifact-${digest.slice(0, 8)}`,
    sha256: digest,
    media_type: "application/octet-stream",
    byte_length: 1,
  });
  const base_model = {
    component: "model/qwen",
    revision: overrides.base ?? "rev-1",
  };
  const tokenizer = {
    component: "tokenizer/qwen",
    revision: overrides.tokenizer ?? "rev-1",
  };
  const chat = overrides.template ?? TEMPLATE;
  return {
    specialist_id: "coder",
    revision: "1",
    scope: context.scope,
    tested_task_coverage: ["code/typescript"],
    base_model,
    tokenizer,
    chat_template: ref(chat),
    adapter: adapter === null ? null : ref(adapter),
    tools: [],
    skills: [],
    knowledge: [],
    evaluation: ref(sha("eval")),
    dataset_lineage: null,
    fallback_specialist_revision: "base",
    profile: {
      schema_version: 1,
      display_name: "Coder",
      roles: ["worker"],
      complexity: ["medium"],
      serving: overrides.bindings ?? [
        {
          model_id: `vllm/${adapter ?? "mars-base"}`,
          provider_id: "vllm",
          provider_model: adapter ?? "mars-base",
          adapter_format: adapter === null ? null : "peft-lora",
        },
      ],
      adapter_spec:
        adapter === null || overrides.format === null
          ? null
          : {
              format: "peft-lora",
              base_model,
              tokenizer,
              chat_template_sha256: chat,
            },
      acceptance: {
        min_heldout_tasks_per_coverage: 1,
        min_pass_rate_delta_vs_base: 0,
        min_pass_rate_delta_vs_prompt_optimized: 0,
        min_pass_rate_delta_vs_current: 0,
        max_regressions: 0,
        max_cost_usd_per_task: null,
        max_runtime_ms_p95: null,
      },
      limitations: [],
    },
  } as SpecialistRegistration;
}

const servers: FakeVllm[] = [];
function fake(options: Parameters<typeof startFakeVllm>[0] = {}): FakeVllm {
  const server = startFakeVllm(options);
  servers.push(server);
  return server;
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    expect(server.modelRequests()).toEqual([]);
    await server.stop();
  }
});

function manager(server: FakeVllm, runtime = false, catalog?: ModelCatalog) {
  return new VllmAdapterManager({
    client: new VllmClient({ url: server.url }),
    profile,
    runtimeLoraUpdating: runtime,
    ...(catalog ? { catalog } : {}),
  });
}

async function reasons(server: FakeVllm, reg: SpecialistRegistration) {
  const readiness = await checkServingReadiness(context, reg, {
    catalog: vllmCatalog(profile),
    servingAttestor: createVllmServingAttestor({
      client: new VllmClient({ url: server.url }),
      profile,
    }),
  });
  return readiness.map((entry) => [entry.serving_attestation, entry.reasons]);
}

describe("pin and URL policy", () => {
  test("pin matches sources/manifest.json", async () => {
    const manifest = JSON.parse(
      await readFile(
        join(import.meta.dir, "../../../sources/manifest.json"),
        "utf8",
      ),
    ) as {
      components: {
        id: string;
        revision: string;
        integration_status: string;
      }[];
    };
    const vllm = manifest.components.find(({ id }) => id === "vllm");
    expect(vllm?.revision).toBe(VLLM_PIN.revision);
  });

  test("accepts only the pinned release", () => {
    expect(versionMatchesPin("0.32.0")).toBe(true);
    expect(versionMatchesPin("0.32.0+cu130")).toBe(true);
    for (const v of [
      "0.32.1",
      "0.32.0rc1",
      "0.32.0.dev3",
      "0.31.0",
      "",
      "0.32.0+a+b",
    ])
      expect(versionMatchesPin(v)).toBe(false);
  });

  test("loopback by default, remote only with explicit allow and https", () => {
    expect(vllmOrigin()).toBe("http://127.0.0.1:8000");
    expect(vllmOrigin("http://localhost:9000/v1/")).toBe(
      "http://localhost:9000",
    );
    expect(() => vllmOrigin("https://gpu.example.com")).toThrow(/allow-remote/);
    expect(() =>
      vllmOrigin("http://gpu.example.com", { allowRemote: true }),
    ).toThrow(/https/);
    expect(vllmOrigin("https://gpu.example.com", { allowRemote: true })).toBe(
      "https://gpu.example.com",
    );
    for (const bad of [
      "ftp://127.0.0.1",
      "http://u:p@127.0.0.1",
      "http://127.0.0.1/x",
      "http://127.0.0.1?a=1",
    ])
      expect(() => vllmOrigin(bad)).toThrow();
  });

  test("provider stays openai-compatible and the registry keeps paid policy", async () => {
    const provider = vllmProvider({
      url: "http://127.0.0.1:8000",
      apiKeyEnv: "MARS_VLLM_API_KEY",
    });
    expect(provider.kind).toBe("openai-compatible");
    expect(provider.baseUrl).toBe("http://127.0.0.1:8000/v1");
    const base = await loadModelRegistry({
      cwd: import.meta.dir,
      home: "/nonexistent",
      env: {},
    });
    const models = vllmModels(profile, {
      context_window: 4096,
      adapter_sha256s: [ADAPTER, "not-a-sha"],
    });
    expect(models.map((m) => m.id)).toEqual([
      "vllm/mars-base",
      `vllm/${ADAPTER}`,
    ]);
    const registry = extendRegistryWithVllm(base, {
      url: "http://127.0.0.1:8000",
      models,
    });
    expect(registry.policy.allowPaid).toBe(base.policy.allowPaid);
    expect(registry.getModel(`vllm/${ADAPTER}`)?.pricing.free).toBe(true);
  });
});

describe("attestor fails closed", () => {
  test("unreachable server is unattested", async () => {
    const server = fake();
    const url = server.url;
    await server.stop();
    servers.splice(servers.indexOf(server), 1);
    const attestor = createVllmServingAttestor({
      client: new VllmClient({ url, timeoutMs: 500 }),
      profile,
    });
    expect(
      await attestor.attest(
        context,
        registration().profile.serving[0] as ServingBinding,
      ),
    ).toBeNull();
  });

  for (const malformed of ["version", "models", "not-json"] as const)
    test(`malformed ${malformed} response is unattested`, async () => {
      const server = fake({
        malformed,
        adapters: { [ADAPTER]: artifact(ADAPTER).path },
      });
      expect(await reasons(server, registration())).toEqual([
        ["absent", ["serving_unattested"]],
      ]);
    });

  test("a response body that stalls past the deadline is unattested", async () => {
    const stalled = async () =>
      new Response(new ReadableStream({ start() {} }), { status: 200 });
    const client = new VllmClient({ fetch: stalled, timeoutMs: 50 });
    await expect(client.version()).rejects.toMatchObject({
      code: "unreachable",
    });
    const attestor = createVllmServingAttestor({ client, profile });
    expect(
      await attestor.attest(
        context,
        registration().profile.serving[0] as ServingBinding,
      ),
    ).toBeNull();
  });

  test("version mismatch is unattested", async () => {
    const server = fake({
      version: "0.33.0",
      adapters: { [ADAPTER]: artifact(ADAPTER).path },
    });
    await expect(
      new VllmClient({ url: server.url }).assertPinnedVersion(),
    ).rejects.toMatchObject({
      code: "version_mismatch",
    });
    expect(await reasons(server, registration())).toEqual([
      ["absent", ["serving_unattested"]],
    ]);
  });

  test("wrong served base name, model path or provider is unattested", async () => {
    for (const options of [
      { baseName: "other" },
      { baseRoot: "/models/other" },
    ]) {
      const server = fake({ ...options, adapters: { [ADAPTER]: "/a" } });
      await expect(
        readVllmServing(new VllmClient({ url: server.url }), profile),
      ).rejects.toThrow();
      expect(await reasons(server, registration())).toEqual([
        ["absent", ["serving_unattested"]],
      ]);
    }
    const server = fake();
    const attestor = createVllmServingAttestor({
      client: new VllmClient({ url: server.url }),
      profile,
    });
    expect(
      await attestor.attest(context, {
        model_id: "x/mars-base",
        provider_id: "other",
        provider_model: "mars-base",
        adapter_format: null,
      }),
    ).toBeNull();
    expect(
      await attestor.attest(context, {
        model_id: "vllm/unknown",
        provider_id: "vllm",
        provider_model: "unknown",
        adapter_format: null,
      }),
    ).toBeNull();
    expect(server.requests.length).toBe(2);
  });

  test("unauthorized server is unattested; key is sent by env name only", async () => {
    const server = fake({
      apiKey: "secret-value",
      adapters: { [ADAPTER]: "/a" },
    });
    const wrong = createVllmServingAttestor({
      client: new VllmClient({ url: server.url }),
      profile,
    });
    expect(
      await wrong.attest(
        context,
        registration().profile.serving[0] as ServingBinding,
      ),
    ).toBeNull();
    const right = createVllmServingAttestor({
      client: new VllmClient({
        url: server.url,
        apiKeyEnv: "MARS_VLLM_API_KEY",
        env: { MARS_VLLM_API_KEY: "secret-value" },
      }),
      profile,
    });
    const attestation = await right.attest(
      context,
      registration().profile.serving[0] as ServingBinding,
    );
    expect(attestation?.loaded_adapter_sha256s).toEqual([ADAPTER]);
    expect(JSON.stringify(attestation)).not.toContain("secret-value");
  });
});

describe("attestation reason codes via checkServingReadiness", () => {
  test("loaded, matching adapter attests with no reasons", async () => {
    const server = fake({
      adapters: { [ADAPTER]: artifact(ADAPTER).path, "not-sha": "/x" },
    });
    expect(await reasons(server, registration())).toEqual([["verified", []]]);
  });

  test("each mismatch reason code", async () => {
    const server = fake({ adapters: { [ADAPTER]: "/a" } });
    const cases: [SpecialistRegistration, ReasonCode[]][] = [
      [registration({ base: "rev-2" }), ["serving_base_mismatch"]],
      [registration({ tokenizer: "rev-2" }), ["serving_tokenizer_mismatch"]],
      [
        registration({ template: sha("other") }),
        ["serving_chat_template_mismatch"],
      ],
      [registration({ adapter: ADAPTER_2 }), ["serving_adapter_not_loaded"]],
      [registration({ format: null }), ["serving_adapter_unsupported"]],
      [
        registration({
          bindings: [
            {
              model_id: "vllm/alias",
              provider_id: "vllm",
              provider_model: ADAPTER,
              adapter_format: "peft-lora",
            },
          ],
        }),
        ["model_binding_mismatch"],
      ],
    ];
    const aliasCatalog: ModelCatalog = {
      ...vllmCatalog(profile),
      getModel: (id) =>
        id === "vllm/alias"
          ? vllmCatalog(profile).getModel(`vllm/${ADAPTER}`)
          : vllmCatalog(profile).getModel(id),
    };
    for (const [reg, expected] of cases) {
      const readiness = await checkServingReadiness(context, reg, {
        catalog: aliasCatalog,
        servingAttestor: createVllmServingAttestor({
          client: new VllmClient({ url: server.url }),
          profile,
        }),
      });
      expect(readiness.map((r) => r.reasons)).toEqual([expected]);
    }
    expect(await reasons(fake({ version: "0.31.0" }), registration())).toEqual([
      ["absent", ["serving_unattested"]],
    ]);
  });
});

describe("adapter lifecycle", () => {
  test("wrong base, tokenizer, template, hash or format is refused before any vLLM call", async () => {
    const server = fake({ runtimeLoraUpdating: true });
    const m = manager(server, true);
    const cases: [SpecialistRegistration, AdapterArtifact, string][] = [
      [
        registration({ base: "rev-2" }),
        artifact(ADAPTER),
        "serving_base_mismatch",
      ],
      [
        registration({ tokenizer: "rev-2" }),
        artifact(ADAPTER),
        "serving_tokenizer_mismatch",
      ],
      [
        registration({ template: sha("x") }),
        artifact(ADAPTER),
        "serving_chat_template_mismatch",
      ],
      [registration(), artifact(ADAPTER_2), "artifact_hash_mismatch"],
      [
        registration({ format: null }),
        artifact(ADAPTER),
        "adapter_format_unsupported",
      ],
      [registration({ adapter: null }), artifact(ADAPTER), "adapter_missing"],
      [
        registration({
          bindings: [
            {
              model_id: "x/y",
              provider_id: "other",
              provider_model: ADAPTER,
              adapter_format: "peft-lora",
            },
          ],
        }),
        artifact(ADAPTER),
        "no_vllm_binding",
      ],
    ];
    for (const [reg, art, code] of cases) {
      await expect(m.load(context, reg, art)).rejects.toMatchObject({ code });
      expect(() =>
        m.staticLoraModules([{ registration: reg, artifact: art }]),
      ).toThrow(VllmAdapterRefused);
    }
    await expect(
      m.rollback(context, ADAPTER_2, {
        registration: registration({ base: "rev-2" }),
        artifact: artifact(ADAPTER),
      }),
    ).rejects.toMatchObject({ code: "serving_base_mismatch" });
    expect(server.requests).toEqual([]);
  });

  test("runtime LoRA is refused without the dev flag; static modules are the default", async () => {
    const server = fake({ runtimeLoraUpdating: true });
    const m = manager(server);
    expect(m.runtimeLoraUpdating).toBe(false);
    await expect(
      m.load(context, registration(), artifact(ADAPTER)),
    ).rejects.toMatchObject({ code: "runtime_lora_disabled" });
    await expect(m.unload(ADAPTER)).rejects.toMatchObject({
      code: "runtime_lora_disabled",
    });
    await expect(m.rollback(context, ADAPTER)).rejects.toMatchObject({
      code: "runtime_lora_disabled",
    });
    expect(server.requests).toEqual([]);
    const modules = m.staticLoraModules([
      { registration: registration(), artifact: artifact(ADAPTER) },
    ]);
    expect(JSON.parse(modules[0] as string)).toEqual({
      name: ADAPTER,
      path: artifact(ADAPTER).path,
      base_model_name: "mars-base",
    });
    const argv = vllmServeArgv(profile, modules);
    expect(argv.slice(0, 5)).toEqual([
      "vllm",
      "serve",
      "/models/mars-base",
      "--served-model-name",
      "mars-base",
    ]);
    expect(argv).toContain("--enable-lora");
    expect(argv.join(" ")).not.toContain("VLLM_ALLOW_RUNTIME_LORA_UPDATING");
    expect(vllmServeArgv(profile, [])).not.toContain("--enable-lora");
  });

  test("dev flag against a server without runtime updating reports it clearly", async () => {
    const server = fake({ runtimeLoraUpdating: false });
    await expect(
      manager(server, true).load(context, registration(), artifact(ADAPTER)),
    ).rejects.toMatchObject({
      code: "runtime_lora_unavailable",
    });
  });

  test("load attests, unload verifies, rollback restores the previous adapter", async () => {
    const server = fake({ runtimeLoraUpdating: true });
    const m = manager(server, true);
    const first = registration();
    const second = registration({ adapter: ADAPTER_2 });
    const ready = await m.load(context, first, artifact(ADAPTER));
    expect(ready.map((r) => [r.serving_attestation, r.reasons])).toEqual([
      ["verified", []],
    ]);
    await m.load(context, first, artifact(ADAPTER));
    expect(
      server.requests.filter((r) => r.path === "/v1/load_lora_adapter"),
    ).toHaveLength(1);
    expect(
      server.requests.find((r) => r.path === "/v1/load_lora_adapter")?.body,
    ).toEqual({
      lora_name: ADAPTER,
      lora_path: artifact(ADAPTER).path,
    });
    await m.load(context, second, artifact(ADAPTER_2));
    const result = await m.rollback(context, ADAPTER_2, {
      registration: first,
      artifact: artifact(ADAPTER),
    });
    expect(result.unloaded).toBe(ADAPTER_2);
    expect(result.restored).toBe(ADAPTER);
    expect([...server.state.adapters.keys()]).toEqual([ADAPTER]);
    expect(await reasons(server, second)).toEqual([
      ["verified", ["serving_adapter_not_loaded"]],
    ]);
    expect(await m.rollback(context, ADAPTER)).toEqual({
      unloaded: ADAPTER,
      restored: null,
      readiness: [],
    });
    expect(server.state.adapters.size).toBe(0);
    expect(await m.unload(ADAPTER)).toBe(false);
    await expect(m.unload("nope")).rejects.toMatchObject({
      code: "artifact_hash_mismatch",
    });
  });

  test("an adapter name already served from another path is refused, not reused", async () => {
    const server = fake({
      runtimeLoraUpdating: true,
      adapters: { [ADAPTER]: "/elsewhere" },
    });
    await expect(
      manager(server, true).load(context, registration(), artifact(ADAPTER)),
    ).rejects.toMatchObject({ code: "adapter_path_mismatch" });
    expect(
      server.requests.filter((r) => r.method === "POST").map((r) => r.path),
    ).toEqual([]);
    expect(server.state.adapters.get(ADAPTER)).toBe("/elsewhere");
  });

  test("unload that leaves the adapter listed is reported", async () => {
    const server = fake({
      runtimeLoraUpdating: true,
      stickyUnload: true,
      adapters: { [ADAPTER]: "/a" },
    });
    await expect(manager(server, true).unload(ADAPTER)).rejects.toMatchObject({
      code: "still_loaded",
    });
  });

  test("a load that does not attest is unloaded again", async () => {
    const server = fake({ runtimeLoraUpdating: true });
    const empty: ModelCatalog = {
      policy: { allowPaid: false },
      getModel: () => undefined,
      unavailableReason: () => undefined,
    };
    await expect(
      manager(server, true, empty).load(
        context,
        registration(),
        artifact(ADAPTER),
      ),
    ).rejects.toMatchObject({
      code: "not_ready",
      reasons: ["model_not_configured", "serving_unattested"],
    });
    expect(server.state.adapters.size).toBe(0);
  });

  test("a failed load leaves an adapter that was already serving loaded", async () => {
    const server = fake({
      runtimeLoraUpdating: true,
      adapters: { [ADAPTER]: artifact(ADAPTER).path },
    });
    const empty: ModelCatalog = {
      policy: { allowPaid: false },
      getModel: () => undefined,
      unavailableReason: () => undefined,
    };
    await expect(
      manager(server, true, empty).load(
        context,
        registration(),
        artifact(ADAPTER),
      ),
    ).rejects.toMatchObject({ code: "not_ready" });
    expect(server.requests.filter((r) => r.method === "POST")).toEqual([]);
    expect(server.state.adapters.has(ADAPTER)).toBe(true);
  });
});
