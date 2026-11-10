import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@mars/contracts";
import {
  openRuntimeSession,
  type RuntimeSessionOptions,
} from "@mars/execution";
import { loadModelRegistry } from "@mars/providers";
import { startFakeAgentServer } from "@mars/workspaces-remote";
import { MarsClient } from "../../../apps/vscode/src/client";
import { HttpRpcTransport } from "../../../apps/vscode/src/rpc";
import { createWorkbenchService } from "./service";

/*
 * End-to-end: the real workbench host + actual SDK runtime (injected model
 * responses) with the REMOTE workspace provider talking to a FAKE OpenHands
 * Agent Server over HTTP. Planning and model calls stay in the host; every
 * workspace operation crosses the pinned wire protocol. Not live acceptance.
 */
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const scope = { owner_id: "remote-owner", project_id: "remote-project" };
const KEY = "fake-agent-server-session-key-42";

function sse(delta: object, reason = "stop") {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }], usage: { prompt_tokens: 50, completion_tokens: 12 } })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}
function toolCall(id: string, name: string, args: object) {
  return sse(
    {
      tool_calls: [
        {
          index: 0,
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    "tool_calls",
  );
}
async function eventually<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
): Promise<T> {
  const until = Date.now() + 15_000;
  while (true) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > until)
      throw new Error("Expected service state was not reached");
    await new Promise((yes) => setTimeout(yes, 20));
  }
}
function task(request: string): Task {
  return {
    schema_version: 1,
    task_id: randomUUID(),
    session_id: randomUUID(),
    scope,
    revision: 0,
    request,
    acceptance_criteria: ["repair.txt contains repaired"],
    budget: {
      max_tokens: 24000,
      max_usd: 0,
      max_duration_ms: 60000,
      max_depth: 0,
      max_concurrency: 1,
    },
    status: "pending",
    specialist_revision: null,
    artifacts: [],
  };
}

async function fixture(options: { version?: string } = {}) {
  const base = await mkdtemp(join(tmpdir(), "mars-remote-service-"));
  cleanup.push(() => rm(base, { recursive: true, force: true }));
  const source = join(base, "source");
  const home = join(base, "home");
  const remoteRoot = join(base, "agent-server-workspace");
  await mkdir(source);
  await writeFile(join(source, "baseline.txt"), "untouched\n");
  await mkdir(join(base, "checks"));
  await writeFile(
    join(base, "checks", "verify.sh"),
    'test "$(cat repair.txt)" = repaired && test -f ran.txt\n',
  );
  await writeFile(
    join(base, "checks", "checks.json"),
    JSON.stringify({
      schema_version: 1,
      checks: [
        {
          id: "repair-test",
          label: "repair.txt is repaired",
          argv: ["sh", "verify.sh"],
          protected_files: [{ path: "verify.sh", source: "verify.sh" }],
        },
      ],
    }),
  );
  await mkdir(join(home, ".mars"), { recursive: true });
  await writeFile(
    join(home, ".mars", "models.json"),
    JSON.stringify({
      version: 1,
      providers: [
        {
          id: "fixture",
          kind: "openai-compatible",
          baseUrl: "https://fixture.invalid/v1",
          apiKeyEnv: "FIXTURE_KEY",
        },
      ],
      models: [
        {
          id: "fixture/free",
          providerId: "fixture",
          model: "stub",
          capabilities: { tools: true, vision: false, contextWindow: 32000 },
          pricing: { free: true },
        },
      ],
      routes: { default: ["fixture/free"] },
    }),
  );
  const registry = await loadModelRegistry({
    cwd: source,
    home,
    env: { FIXTURE_KEY: "dummy-not-real" },
  });
  const fake = await startFakeAgentServer({
    workingDir: remoteRoot,
    apiKey: KEY,
    ...(options.version ? { version: options.version } : {}),
  });
  cleanup.push(() => fake.stop());
  async function start(fetch: NonNullable<RuntimeSessionOptions["fetch"]>) {
    const service = await createWorkbenchService({
      sourceRoot: source,
      stateRoot: join(base, "state"),
      scope,
      registry,
      port: 0,
      checksFile: join(base, "checks", "checks.json"),
      remoteWorkspace: {
        url: fake.url,
        apiKey: KEY,
        apiKeyEnv: "MARS_AGENT_SERVER_API_KEY",
        remoteRoot,
        allowInsecureHttp: false,
      },
      runtimeFactory: (runtime) => openRuntimeSession({ ...runtime, fetch }),
    });
    cleanup.push(() => service.close());
    const connection = JSON.parse(
      await readFile(service.connectionFile, "utf8"),
    ) as { token: string };
    const client = new MarsClient(
      new HttpRpcTransport({
        rpcUrl: `${service.url}/v1/rpc`,
        getToken: async () => connection.token,
      }),
    );
    await client.describe();
    return { service, client };
  }
  return { base, source, remoteRoot, fake, start };
}

test("remote provider: a task runs end to end through the host with host checks, exact export, checkpoint/restore (FAKE Agent Server)", async () => {
  const f = await fixture();
  let requests = 0;
  const { client, service } = await f.start(async () => {
    requests++;
    if (requests === 1)
      return toolCall("w", "mars_write", {
        path: "repair.txt",
        content: "repaired",
      });
    if (requests === 2)
      return toolCall("x", "mars_execute", {
        argv: ["sh", "-c", "echo ran > ran.txt"],
      });
    return sse({ content: "Repaired." });
  });
  expect(client.server?.capabilities.execute).toBe(true);
  expect(service.workspaceIsolation?.os_isolation).toBe("none");
  expect(service.workspaceIsolation?.statement).toContain(
    "not an OS isolation guarantee",
  );
  const created = await client.create(
    task("Create repair.txt containing exactly: repaired"),
  );
  await client.start(created.task_id, {
    expectedRevision: 0,
    approvals: { read: true, write: true, execute: true },
    requiredChecks: [
      { kind: "host_test", check_id: "repair-test" },
      { kind: "file_content", path: "repair.txt", content: "repaired" },
    ],
  });
  const finished = await eventually(
    () => client.inspect(created.task_id),
    (value) => value.status !== "running",
  );
  expect(finished.status).toBe("completed");
  expect(requests).toBe(3);

  // The bytes live on the (fake) remote host; the source checkout is untouched.
  const view = await client.verification(created.task_id);
  expect(view.state).toBe("verified");
  expect(view.record?.verified).toBe(true);
  const workspaceId = view.candidate?.workspace_id ?? "";
  expect(
    await readFile(
      join(f.remoteRoot, "ws", workspaceId, "tree", "repair.txt"),
      "utf8",
    ),
  ).toBe("repaired");
  expect(
    await readFile(
      join(f.remoteRoot, "ws", workspaceId, "tree", "ran.txt"),
      "utf8",
    ),
  ).toBe("ran\n");
  await expect(stat(join(f.source, "repair.txt"))).rejects.toThrow();
  const routes = new Set(f.fake.log.map((entry) => entry.route));
  for (const route of [
    "/server_info",
    "/api/file/upload",
    "/api/file/download",
    "/api/bash/start_bash_command",
    "/api/bash/bash_events/search",
  ])
    expect(routes.has(route)).toBe(true);
  expect(
    f.fake
      .startedCommands()
      .some((command) => command.includes("echo ran > ran.txt")),
  ).toBe(true);
  expect(
    f.fake
      .startedCommands()
      .some(
        (command) =>
          command.includes("/checks/") && command.includes("verify.sh"),
      ),
  ).toBe(true);

  const diff = await client.diff(created.task_id);
  expect(diff.files.map((file) => file.path).sort()).toEqual([
    "ran.txt",
    "repair.txt",
  ]);
  const exported = await client.exportPatch(created.task_id, {
    revision: view.candidate?.revision ?? "",
    patchSha256: view.patch_sha256 ?? "",
  });
  expect(exported.verified).toBe(true);
  if (!view.candidate) throw new Error("Missing candidate");
  expect(exported.candidate).toEqual(view.candidate);
  expect(exported.files).toBe(2);

  const checkpoints = await client.checkpoint(created.task_id);
  const restored = await client.restore(
    created.task_id,
    checkpoints,
    checkpoints.workspace.revision,
  );
  expect(restored.workspace_id).toBe(workspaceId);

  for (const ref of finished.artifacts) {
    const artifact = await client.artifact(created.task_id, ref);
    expect(new TextDecoder().decode(artifact.bytes)).not.toContain(KEY);
  }
}, 60_000);

test("remote provider: cancel aborts a running remote task without another model request (FAKE Agent Server)", async () => {
  const f = await fixture();
  let requests = 0;
  const { client } = await f.start(async () => {
    requests++;
    if (requests === 1)
      return toolCall("s", "mars_execute", { argv: ["sleep", "30"] });
    return sse({ content: "unreachable" });
  });
  const created = await client.create(task("Wait for a long command."));
  await client.start(created.task_id, {
    expectedRevision: 0,
    approvals: { read: true, write: true, execute: true },
  });
  await eventually(
    async () =>
      f.fake.startedCommands().some((command) => command.includes("sleep")),
    (started) => started,
  );
  await client.cancel(created.task_id);
  const cancelled = await eventually(
    () => client.inspect(created.task_id),
    (value) => value.status !== "running",
  );
  expect(cancelled.status).toBe("cancelled");
  expect(requests).toBe(1);
  expect(
    f.fake.log.some(
      (entry) => entry.route === "/api/bash/bash_commands/{id}/stop",
    ),
  ).toBe(true);
}, 60_000);

test("remote provider: the service fails closed against an unknown Agent Server version", async () => {
  const f = await fixture({ version: "2.0.0" });
  await expect(f.start(async () => sse({ content: "no" }))).rejects.toThrow(
    "Unsupported Agent Server version",
  );
}, 30_000);
