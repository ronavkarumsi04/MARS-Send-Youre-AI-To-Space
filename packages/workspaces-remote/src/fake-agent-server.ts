import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, normalize, relative } from "node:path";
import { PINNED_AGENT_SERVER, SESSION_KEY_HEADER } from "./client";

/**
 * FAKE OpenHands Agent Server for offline tests. It is NOT the upstream
 * server: it re-implements only the routes, fields and status codes of the
 * pinned revision that the remote provider uses (server_info, bash
 * start/search/stop, file upload/download), running commands as local `sh`
 * subprocesses the way the upstream local runtime does. Passing tests
 * against it is not live acceptance.
 */
export interface FakeAgentServerOptions {
  workingDir: string;
  apiKey?: string;
  version?: string;
  title?: string;
  runtime?: "local" | "docker";
}

export interface FakeFaults {
  /** HTTP status returned (without side effects) for the next N calls of a route. */
  failNext: Map<string, { status: number; count: number }>;
  /** Run the next start_bash_command, then answer 503 as if the response was lost. */
  loseStartResponse: boolean;
  /** Flip one byte of every downloaded file. */
  corruptDownloads: boolean;
  /** Delay every response by this many ms. */
  delayMs: number;
}

export interface FakeAgentServer {
  readonly url: string;
  readonly faults: FakeFaults;
  /** Method + path (+ whether a key header was present) of every request. */
  readonly log: { method: string; route: string; authed: boolean }[];
  startedCommands(): string[];
  setVersion(version: string): void;
  stop(): Promise<void>;
}

interface CommandState {
  id: string;
  command: string;
  events: Record<string, unknown>[];
  proc: ReturnType<typeof Bun.spawn> | null;
  stopped: boolean;
}

export async function startFakeAgentServer(
  options: FakeAgentServerOptions,
): Promise<FakeAgentServer> {
  await mkdir(options.workingDir, { recursive: true });
  const defaultCwd = await realpath(options.workingDir);
  let version = options.version ?? PINNED_AGENT_SERVER.versions[0] ?? "1.59.0";
  const faults: FakeFaults = {
    failNext: new Map(),
    loseStartResponse: false,
    corruptDownloads: false,
    delayMs: 0,
  };
  const log: FakeAgentServer["log"] = [];
  const commands = new Map<string, CommandState>();
  const json = (body: unknown, status = 200): Response =>
    Response.json(body, { status });
  const detail = (status: number, message: string): Response =>
    json({ detail: message }, status);
  const now = (): string => new Date().toISOString();

  const runCommand = (
    state: CommandState,
    cwd: string,
    timeout: number,
  ): void => {
    let order = 0;
    const push = (fields: Record<string, unknown>): void => {
      state.events.push({
        kind: "BashOutput",
        id: randomUUID(),
        timestamp: now(),
        command_id: state.id,
        order: order++,
        exit_code: null,
        stdout: null,
        stderr: null,
        ...fields,
      });
    };
    const proc = Bun.spawn(["sh", "-c", state.command], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: defaultCwd },
    });
    state.proc = proc;
    const pump = async (
      stream: ReadableStream<Uint8Array>,
      key: "stdout" | "stderr",
    ) => {
      const decoder = new TextDecoder();
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        // Upstream caps each event at MAX_CONTENT_CHAR_LENGTH (1 MiB chars).
        for (let i = 0; i < text.length; i += 1024 * 1024)
          push({ [key]: text.slice(i, i + 1024 * 1024) });
      }
    };
    const timer = setTimeout(() => {
      state.stopped = true;
      proc.kill("SIGKILL");
    }, timeout * 1000);
    void Promise.all([
      pump(proc.stdout as ReadableStream<Uint8Array>, "stdout"),
      pump(proc.stderr as ReadableStream<Uint8Array>, "stderr"),
      proc.exited,
    ]).then(() => {
      clearTimeout(timer);
      push({ exit_code: state.stopped ? -1 : (proc.exitCode ?? -1) });
    });
  };

  const insideDefault = async (cwd: string): Promise<boolean> => {
    try {
      const resolved = await realpath(cwd);
      const rel = relative(defaultCwd, resolved);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    } catch {
      return false;
    }
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const route = url.pathname.replace(
        /\/bash_commands\/[^/]+\/stop$/,
        "/bash_commands/{id}/stop",
      );
      log.push({
        method: request.method,
        route,
        authed: request.headers.has(SESSION_KEY_HEADER),
      });
      if (faults.delayMs) await Bun.sleep(faults.delayMs);
      const fail = faults.failNext.get(route);
      if (fail && fail.count > 0) {
        fail.count -= 1;
        return detail(fail.status, "injected fault");
      }
      if (route === "/server_info" && request.method === "GET")
        return json({
          title: options.title ?? PINNED_AGENT_SERVER.title,
          version,
          sdk_version: version,
          tools_version: version,
          workspace_version: version,
          build_git_sha: "fake-agent-server",
          conversation_runtime: options.runtime ?? "local",
          capabilities: ["bash", "files"],
          fake: true,
        });
      if (route === "/alive" || route === "/health")
        return json({ status: "ok" });
      if (!route.startsWith("/api/")) return detail(404, "Not Found");
      if (
        options.apiKey &&
        request.headers.get(SESSION_KEY_HEADER) !== options.apiKey
      )
        return detail(401, "Unauthorized");

      if (
        route === "/api/bash/start_bash_command" &&
        request.method === "POST"
      ) {
        const body = (await request.json().catch(() => null)) as {
          command?: unknown;
          cwd?: unknown;
          timeout?: unknown;
        } | null;
        if (!body || typeof body.command !== "string")
          return detail(422, "invalid body");
        const cwd = typeof body.cwd === "string" ? body.cwd : defaultCwd;
        if (!(await insideDefault(cwd)))
          return detail(422, "cwd must be inside the conversation workspace");
        const state: CommandState = {
          id: randomUUID(),
          command: body.command,
          events: [],
          proc: null,
          stopped: false,
        };
        commands.set(state.id, state);
        runCommand(
          state,
          cwd,
          typeof body.timeout === "number" ? body.timeout : 300,
        );
        if (faults.loseStartResponse) {
          faults.loseStartResponse = false;
          return detail(503, "response lost");
        }
        return json({
          kind: "BashCommand",
          id: state.id,
          timestamp: now(),
          command: body.command,
          cwd,
          timeout: body.timeout ?? 300,
        });
      }
      if (
        route === "/api/bash/bash_events/search" &&
        request.method === "GET"
      ) {
        const commandId = url.searchParams.get("command_id__eq");
        const after = url.searchParams.get("order__gt");
        const limit = Math.min(
          Number(url.searchParams.get("limit") ?? "100"),
          100,
        );
        const offset = Number(url.searchParams.get("page_id") ?? "0");
        const items = [...commands.values()]
          .filter((state) => !commandId || state.id === commandId)
          .flatMap((state) => state.events)
          .filter(
            (event) => after === null || Number(event.order) > Number(after),
          );
        const page = items.slice(offset, offset + limit);
        return json({
          items: page,
          next_page_id:
            offset + limit < items.length ? String(offset + limit) : null,
        });
      }
      if (
        route === "/api/bash/bash_commands/{id}/stop" &&
        request.method === "POST"
      ) {
        const id = url.pathname.split("/").at(-2) ?? "";
        const state = commands.get(id);
        if (!state) return detail(404, "Not Found");
        if (state.proc && state.proc.exitCode === null) {
          state.stopped = true;
          state.proc.kill("SIGKILL");
        }
        return json({ success: true });
      }
      if (route === "/api/file/upload" && request.method === "POST") {
        const path = url.searchParams.get("path") ?? "";
        if (!isAbsolute(path) || normalize(path) !== path)
          return detail(400, "Path must be absolute");
        const form = await request.formData().catch(() => null);
        const file = form?.get("file");
        if (!(file instanceof Blob)) return detail(422, "file is required");
        const data = new Uint8Array(await file.arrayBuffer());
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, data);
        return json({ success: true, file_size: data.byteLength });
      }
      if (route === "/api/file/download" && request.method === "GET") {
        const path = url.searchParams.get("path") ?? "";
        if (!isAbsolute(path)) return detail(400, "Path must be absolute");
        const info = await stat(path).catch(() => null);
        if (!info) return detail(404, "File not found");
        if (!info.isFile()) return detail(400, "Path is not a file");
        const data = new Uint8Array(await Bun.file(path).arrayBuffer());
        if (faults.corruptDownloads && data.byteLength > 0)
          data[0] = (data[0] ?? 0) ^ 0xff;
        return new Response(data, {
          headers: { "content-type": "application/octet-stream" },
        });
      }
      return detail(404, "Not Found");
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    faults,
    log,
    startedCommands: () => [...commands.values()].map((state) => state.command),
    setVersion(next) {
      version = next;
    },
    async stop() {
      for (const state of commands.values()) state.proc?.kill("SIGKILL");
      await server.stop(true);
    },
  };
}
