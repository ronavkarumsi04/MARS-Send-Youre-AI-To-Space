import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModelRegistry } from "@mars/providers";
import {
  createVllmServingAttestor,
  type FakeVllm,
  startFakeVllm,
  VllmClient,
  type VllmServingProfile,
} from "@mars/providers-vllm";
import {
  createFileArtifactStore,
  createSpecialistRegistry,
} from "@mars/specialists";
import {
  artifactRef,
  baseModel,
  context,
  EVIDENCE_SECRET,
  evidenceVerifier,
  fakeCatalog,
  fakeModel,
  MemoryArtifacts,
  makeBaseline,
  makeLineageArtifact,
  makeSpecialistFixture,
  tokenizer,
} from "../../../packages/specialists/tests/helpers";
import { ServeUsageError } from "./cli-errors";
import { attachVllm, splitVllmServeArgs, vllmDoctorReport } from "./vllm";

const entrypoint = join(import.meta.dir, "main.ts");
const ADAPTER = createHash("sha256").update("bundle").digest("hex");
const profile: VllmServingProfile = {
  schema_version: 1,
  served_model_name: "mars-base",
  model_path: "/models/mars-base",
  base_model: { component: "model/qwen", revision: "rev-1" },
  tokenizer: { component: "tokenizer/qwen", revision: "rev-1" },
  chat_template_sha256: createHash("sha256").update("tpl").digest("hex"),
  capabilities: { tools: true, vision: false },
};

const servers: FakeVllm[] = [];
const roots: string[] = [];
function fake(options: Parameters<typeof startFakeVllm>[0] = {}): FakeVllm {
  const server = startFakeVllm(options);
  servers.push(server);
  return server;
}
async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mars-cli-vllm-"));
  roots.push(dir);
  return dir;
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    expect(server.modelRequests()).toEqual([]);
    expect(server.requests.filter(({ method }) => method !== "GET")).toEqual(
      [],
    );
    await server.stop();
  }
  for (const dir of roots.splice(0))
    await rm(dir, { recursive: true, force: true });
});

describe("serve flags", () => {
  test("splits vLLM flags off and leaves the rest strict", () => {
    expect(splitVllmServeArgs(["--port", "0"])).toEqual({
      args: ["--port", "0"],
    });
    expect(
      splitVllmServeArgs([
        "--port",
        "0",
        "--vllm=http://127.0.0.1:8000",
        "--vllm-dev-runtime-lora",
        "--vllm-profile",
        "p.json",
      ]),
    ).toEqual({
      args: ["--port", "0"],
      vllm: {
        url: "http://127.0.0.1:8000",
        allowRemote: false,
        apiKeyEnv: "MARS_VLLM_API_KEY",
        profilePath: "p.json",
        devRuntimeLora: true,
      },
    });
  });

  test("refuses bad combinations with usage errors", () => {
    for (const args of [
      ["--vllm-dev-runtime-lora"],
      ["--vllm"],
      ["--vllm", "--port"],
      ["--vllm", "https://gpu.example.com"],
      ["--vllm", "http://gpu.example.com", "--vllm-allow-remote"],
      ["--vllm", "http://127.0.0.1:1", "--vllm", "http://127.0.0.1:2"],
      ["--vllm", "http://127.0.0.1:1", "--vllm-api-key-env", "lower"],
      ["--vllm", "http://127.0.0.1:1", "--vllm-allow-remote=yes"],
      ["--vllm-unknown"],
    ])
      expect(() => splitVllmServeArgs(args)).toThrow(ServeUsageError);
    expect(
      splitVllmServeArgs([
        "--vllm",
        "https://gpu.example.com",
        "--vllm-allow-remote",
      ]).vllm?.allowRemote,
    ).toBe(true);
  });
});

describe("attach", () => {
  const flags = (url: string, profilePath?: string) => ({
    url,
    allowRemote: false,
    apiKeyEnv: "MARS_VLLM_API_KEY",
    devRuntimeLora: false,
    ...(profilePath ? { profilePath } : {}),
  });

  test("registers the base and attested sha256 adapters without a model request", async () => {
    const dir = await root();
    const profilePath = join(dir, "profile.json");
    await writeFile(profilePath, JSON.stringify(profile));
    const server = fake({ adapters: { [ADAPTER]: "/a", other: "/b" } });
    const base = await loadModelRegistry({ cwd: dir, home: dir, env: {} });
    const { registry, report } = await attachVllm(
      flags(server.url, profilePath),
      base,
      { env: {} },
    );
    expect(report.models).toEqual(["vllm/mars-base", `vllm/${ADAPTER}`]);
    expect(registry.unavailableReason("vllm")).toBeUndefined();
    expect(report.attested).toBe(true);
    expect(report.lora_mode).toBe("static");
    expect(registry.getModel(`vllm/${ADAPTER}`)?.capabilities.tools).toBe(true);
    expect(registry.policy.allowPaid).toBe(base.policy.allowPaid);
    const unprofiled = await attachVllm(flags(server.url), base, { env: {} });
    expect(unprofiled.report.models).toEqual(["vllm/mars-base"]);
    expect(unprofiled.report.attested).toBe(false);
  });

  test("fails closed on unreachable, malformed, off-pin or wrong-profile servers", async () => {
    const dir = await root();
    const base = await loadModelRegistry({ cwd: dir, home: dir, env: {} });
    const profilePath = join(dir, "profile.json");
    await writeFile(
      profilePath,
      JSON.stringify({ ...profile, served_model_name: "other" }),
    );
    const badProfile = join(dir, "bad.json");
    await writeFile(badProfile, "{}");
    const down = fake();
    await down.stop();
    servers.splice(servers.indexOf(down), 1);
    const cases: [ReturnType<typeof flags>, RegExp][] = [
      [flags(down.url), /did not answer/],
      [flags(fake({ malformed: "models" }).url), /not a model list/],
      [flags(fake({ version: "0.31.2" }).url), /pinned to 0\.32\.0/],
      [flags(fake().url, profilePath), /profiled base/],
      [flags(fake().url, badProfile), /--vllm-profile/],
    ];
    for (const [input, message] of cases) {
      const attempt = attachVllm(input, base, { env: {} });
      await expect(attempt).rejects.toThrow(ServeUsageError);
      await expect(attempt).rejects.toThrow(message);
    }
  });
});

describe("doctor", () => {
  test("reports counts and pin match only", async () => {
    const server = fake({ adapters: { [ADAPTER]: "/a" }, apiKey: "k-secret" });
    const report = await vllmDoctorReport({
      url: server.url,
      env: { MARS_VLLM_API_KEY: "k-secret" },
    });
    expect(report.server).toEqual({
      reachable: true,
      version: "0.32.0",
      version_matches_pin: true,
      base_models: 1,
      sha256_adapters: 1,
      error: null,
    });
    expect(report.api_key_present).toBe(true);
    expect(JSON.stringify(report)).not.toContain("k-secret");
    const off = await vllmDoctorReport({
      url: fake({ version: "0.40.0" }).url,
      env: {},
    });
    expect(off.server.version_matches_pin).toBe(false);
    const remote = await vllmDoctorReport({
      url: "https://gpu.example.com",
      env: {},
    });
    expect(remote.server.error).toBe("invalid_url");
    expect(remote.url).toBeNull();
  });
});

async function readFirstLine(
  child: Bun.Subprocess<"ignore", "pipe", "pipe">,
): Promise<string> {
  const reader = child.stdout.getReader();
  let output = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        while (!output.includes("\n")) {
          const part = await reader.read();
          if (part.done) throw new Error("CLI exited before ready");
          output += new TextDecoder().decode(part.value);
        }
      })(),
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("CLI did not start")),
          30_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    reader.releaseLock();
  }
  return output;
}

describe("cli e2e", () => {
  test("mars serve specialists routes an attested adapter and fails closed after unload", async () => {
    const dir = await root();
    const source = join(dir, "source");
    const state = join(dir, "state");
    const home = join(dir, "models");
    await mkdir(source);
    await mkdir(home);
    // The only default target is loopback vLLM; the child inherits no provider keys.
    await writeFile(
      join(home, "models.json"),
      JSON.stringify({
        version: 1,
        providers: [],
        models: [],
        routes: { default: ["vllm/mars-base"] },
        policy: { allowPaid: false },
      }),
    );
    const server = startFakeVllm({
      adapters: { [ADAPTER]: "/adapter" },
      completions: () => "done",
    });
    const chatTemplate = artifactRef(
      "template",
      new TextEncoder().encode("tpl"),
    );
    const servingProfile = {
      ...profile,
      base_model: baseModel,
      tokenizer,
      max_lora_rank: 16,
    };
    const profilePath = join(dir, "profile.json");
    await writeFile(profilePath, JSON.stringify(servingProfile));
    const trustPath = join(dir, "trust.json");
    await writeFile(
      trustPath,
      JSON.stringify({
        schema: "mars.specialist-trust/v1",
        authorities: [
          {
            key_id: "test-key",
            authority_id: "test",
            secret_env: "TEST_SPECIALIST_SECRET",
            owner_ids: [context.scope.owner_id],
            evaluator_ids: ["eval-1"],
          },
        ],
      }),
    );
    const registryDir = join(dir, "registry");
    const artifacts = createFileArtifactStore(join(registryDir, "artifacts"));
    const memory = new MemoryArtifacts();
    const lineage = await makeLineageArtifact(memory, context.scope, {
      synthetic: false,
    });
    const fixture = await makeSpecialistFixture(memory, {
      synthetic: false,
      adapter: { ...artifactRef("adapter"), sha256: ADAPTER },
      chatTemplate,
      adapterFormat: "peft-lora",
      adapterSpec: {
        format: "peft-lora",
        base_model: baseModel,
        tokenizer,
        chat_template_sha256: chatTemplate.sha256,
      },
      datasetLineage: lineage,
      serving: [
        {
          model_id: `vllm/${ADAPTER}`,
          provider_id: "vllm",
          provider_model: ADAPTER,
          adapter_format: "peft-lora",
        },
      ],
    });
    for (const ref of [fixture.registration.evaluation, lineage]) {
      await artifacts.put(
        context,
        await memory.get(context, ref),
        ref.media_type,
      );
    }
    const registry = createSpecialistRegistry({
      rootDir: registryDir,
      artifacts,
      servingAttestor: createVllmServingAttestor({
        client: new VllmClient({ url: server.url }),
        profile: servingProfile,
      }),
      catalog: fakeCatalog({
        models: [
          fakeModel({
            id: "vllm/mars-base",
            providerId: "vllm",
            model: "mars-base",
          }),
          fakeModel({
            id: `vllm/${ADAPTER}`,
            providerId: "vllm",
            model: ADAPTER,
          }),
        ],
      }),
      evidenceVerifier: evidenceVerifier(),
    });
    await registry.registerBaseline(
      context,
      makeBaseline(context.scope, {
        model_id: "vllm/mars-base",
        provider_id: "vllm",
        provider_model: "mars-base",
      }),
    );
    await registry.registerSpecialist(context, fixture.registration);
    await registry.promote(context, "specialist-1", "1", null);
    registry.close();
    const child = Bun.spawn(
      [
        process.execPath,
        entrypoint,
        "serve",
        "--source",
        source,
        "--state",
        state,
        "--port",
        "0",
        "--owner",
        context.scope.owner_id,
        "--project",
        context.scope.project_id,
        "--vllm",
        server.url,
        "--vllm-profile",
        profilePath,
        "--specialists-registry",
        registryDir,
        "--specialists-trust",
        trustPath,
        "--specialists-domain",
        "coding/mechanical-edit",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        env: {
          PATH: process.env.PATH,
          HOME: dir,
          MARS_HOME: home,
          TEST_SPECIALIST_SECRET: new TextDecoder().decode(EVIDENCE_SECRET),
        },
      },
    );
    try {
      const report = JSON.parse(await readFirstLine(child));
      expect(report.specialists).toEqual({
        domain: "coding/mechanical-edit",
        complexity: "medium",
        serving_attestation: "vllm",
        step_routing: true,
      });
      const connection = JSON.parse(
        await readFile(report.connection_file, "utf8"),
      );
      const rpc = async (method: string, params: unknown) => {
        const response = await fetch(`${report.url}/v1/rpc`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${connection.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ method, context, params }),
        });
        return response.json();
      };
      for (const loaded of [true, false]) {
        if (!loaded) server.state.adapters.clear();
        const taskId = loaded ? "loaded" : "unloaded";
        await rpc("tasks.create", {
          task: {
            schema_version: 1,
            task_id: taskId,
            session_id: `session-${taskId}`,
            scope: context.scope,
            revision: 0,
            request: "Say done",
            acceptance_criteria: ["done"],
            budget: {
              max_tokens: 64000,
              max_usd: 1,
              max_duration_ms: 10000,
              max_depth: 1,
              max_concurrency: 1,
            },
            status: "pending",
            specialist_revision: null,
            artifacts: [],
          },
        });
        await rpc("tasks.start", {
          task_id: taskId,
          expected_revision: 0,
          approvals: { read: false, write: false, execute: false },
        });
        const events = await rpc("tasks.events", { task_id: taskId });
        const payloads = [];
        for (const event of events.result) {
          if (
            event.event_type !== "tool.completed" ||
            event.producer !== "@mars/workbench"
          )
            continue;
          const artifact = await rpc("tasks.artifact", {
            task_id: taskId,
            artifact: event.payload,
          });
          payloads.push(
            JSON.parse(
              Buffer.from(artifact.result.data_base64, "base64").toString(
                "utf8",
              ),
            ),
          );
        }
        const serialized = JSON.stringify(payloads);
        expect(serialized).toContain('"operation":"routing"');
        expect(serialized).toContain(
          loaded
            ? '"ref":"specialist:specialist-1@1"'
            : '"ref":"baseline:baseline@1"',
        );
        if (loaded) {
          expect(serialized).toContain('"status":"routed"');
          const launch = JSON.parse(
            await readFile(
              join(
                state,
                "sessions",
                createHash("sha256")
                  .update(
                    JSON.stringify([
                      context.scope.owner_id,
                      context.scope.project_id,
                      null,
                      taskId,
                    ]),
                  )
                  .digest("hex"),
                "launch.json",
              ),
              "utf8",
            ),
          );
          expect(launch.model_id).toBe(`vllm/${ADAPTER}`);
        } else expect(serialized).toContain("serving_adapter_not_loaded");
        await rpc("tasks.cancel", { task_id: taskId });
      }
      expect(
        server
          .modelRequests()
          .every(({ body }) =>
            ["mars-base", ADAPTER].includes((body as { model: string }).model),
          ),
      ).toBe(true);
    } finally {
      child.kill("SIGTERM");
      await child.exited;
      await server.stop();
    }
  }, 60_000);
  test("mars serve --vllm attaches, reports the target and closes cleanly", async () => {
    const dir = await root();
    const source = join(dir, "source");
    await mkdir(source);
    const profilePath = join(dir, "profile.json");
    await writeFile(profilePath, JSON.stringify(profile));
    const server = fake({ adapters: { [ADAPTER]: "/a" } });
    const child = Bun.spawn(
      [
        process.execPath,
        entrypoint,
        "serve",
        "--source",
        source,
        "--state",
        join(dir, "state"),
        "--port",
        "0",
        "--vllm",
        server.url,
        "--vllm-profile",
        profilePath,
        "--vllm-dev-runtime-lora",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        env: { PATH: process.env.PATH, HOME: dir, MARS_HOME: join(dir, "m") },
      },
    );
    try {
      const report = JSON.parse(await readFirstLine(child));
      expect(report.status).toBe("listening");
      expect(report.vllm).toMatchObject({
        provider_id: "vllm",
        version: "0.32.0",
        base_model: "mars-base",
        attested: true,
        adapters: 1,
        models: ["vllm/mars-base", `vllm/${ADAPTER}`],
        lora_mode: "dev-runtime",
        live_verified: false,
      });
      child.kill("SIGTERM");
      expect(await child.exited).toBe(143);
      expect(await new Response(child.stderr).text()).toBe("");
      expect(server.requests.map(({ path }) => path)).toEqual([
        "/version",
        "/v1/models",
      ]);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  }, 60_000);

  test("mars serve --vllm refuses to start against an off-pin server", async () => {
    const dir = await root();
    const source = join(dir, "source");
    await mkdir(source);
    const server = fake({ version: "0.33.0" });
    const child = Bun.spawn(
      [
        process.execPath,
        entrypoint,
        "serve",
        "--source",
        source,
        "--state",
        join(dir, "state"),
        "--port",
        "0",
        "--vllm",
        server.url,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        env: { PATH: process.env.PATH, HOME: dir, MARS_HOME: join(dir, "m") },
      },
    );
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stdout).text()).toBe("");
    const stderr = await new Response(child.stderr).text();
    expect(stderr).toContain("pinned to 0.32.0");
    expect(stderr).toContain("refuses to start");
  }, 60_000);

  test("mars doctor reports the vllm section", async () => {
    const dir = await root();
    const server = fake({ adapters: { [ADAPTER]: "/a" } });
    const child = Bun.spawn(
      [process.execPath, entrypoint, "doctor", "--vllm", server.url],
      {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        env: { PATH: process.env.PATH, HOME: dir, MARS_HOME: join(dir, "m") },
      },
    );
    expect(await child.exited).toBe(0);
    const report = JSON.parse(await new Response(child.stdout).text());
    expect(report.vllm).toMatchObject({
      package: "@mars/providers-vllm",
      pinned_release: "v0.32.0",
      pinned_revision: "5df63a7203cdb9328d824a27b682e77c7b9928be",
      server: {
        reachable: true,
        version_matches_pin: true,
        sha256_adapters: 1,
      },
      lora_mode_default: "static --lora-modules",
      live_verified: false,
    });
  }, 60_000);
});
