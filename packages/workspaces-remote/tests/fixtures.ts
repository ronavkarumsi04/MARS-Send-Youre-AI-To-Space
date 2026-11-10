import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createInMemoryArtifactStore,
  createLocalWorkspaceProvider,
  type SandboxRunner,
  type WorkspaceLimits,
} from "@mars/workspaces";
import {
  type AgentServerClientOptions,
  createAgentServerClient,
  createRemoteWorkspaceProvider,
  type FakeAgentServer,
  type RemoteWorkspaceProvider,
  startFakeAgentServer,
} from "../src";
import { type ConformanceFixture, SOURCE_FILES } from "./conformance";

export async function makeSource(base: string): Promise<string> {
  const source = join(base, "source");
  for (const [path, content] of Object.entries(SOURCE_FILES)) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), content);
  }
  return source;
}

/**
 * TEST-ONLY, UNSANDBOXED runner: executes argv as a host subprocess so the
 * local provider runs the same commands the remote fake runs. Never used
 * outside tests.
 */
export function hostProcessRunner(): SandboxRunner {
  return {
    isolation: "test-host-process",
    async verify() {},
    async cleanup() {},
    async run(request) {
      const proc = Bun.spawn([...request.argv], {
        cwd: request.workspaceDir,
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      });
      let timedOut = false;
      let cancelled = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, request.timeoutMs);
      const abort = () => {
        cancelled = true;
        proc.kill("SIGKILL");
      };
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) abort();
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).bytes(),
        new Response(proc.stderr).bytes(),
        proc.exited,
      ]);
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
      return {
        exitCode: proc.exitCode ?? -1,
        stdout: stdout.subarray(0, request.maxOutputBytes),
        stderr: stderr.subarray(0, request.maxOutputBytes),
        stdoutTruncated: stdout.byteLength > request.maxOutputBytes,
        stderrTruncated: stderr.byteLength > request.maxOutputBytes,
        timedOut,
        cancelled: cancelled && !timedOut,
      };
    },
  };
}

export async function localFixture(options?: {
  limits?: Partial<WorkspaceLimits>;
}): Promise<ConformanceFixture> {
  const base = await mkdtemp(join(tmpdir(), "mars-conf-local-"));
  const artifacts = createInMemoryArtifactStore();
  const provider = await createLocalWorkspaceProvider({
    rootDir: join(base, "state"),
    sourceRoot: await makeSource(base),
    artifacts,
    sandbox: hostProcessRunner(),
    approveCommand: async () => true,
    ...(options?.limits ? { limits: options.limits } : {}),
  });
  return {
    provider,
    artifacts,
    async tamper(context, workspace, path, content) {
      await writeFile(
        join(await provider.workspacePath(context, workspace), path),
        content,
      );
    },
    async close() {
      await provider.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

export interface RemoteFixture extends ConformanceFixture {
  provider: RemoteWorkspaceProvider;
  fake: FakeAgentServer;
  base: string;
  remoteRoot: string;
}

export const API_KEY = "fake-session-key-0123456789";

export async function remoteFixture(options?: {
  limits?: Partial<WorkspaceLimits>;
  client?: Partial<AgentServerClientOptions>;
}): Promise<RemoteFixture> {
  const base = await mkdtemp(join(tmpdir(), "mars-conf-remote-"));
  const remoteRoot = join(base, "remote");
  const fake = await startFakeAgentServer({
    workingDir: remoteRoot,
    apiKey: API_KEY,
  });
  const artifacts = createInMemoryArtifactStore();
  let provider: RemoteWorkspaceProvider;
  try {
    provider = await createRemoteWorkspaceProvider({
      rootDir: join(base, "state"),
      sourceRoot: await makeSource(base),
      artifacts,
      client: createAgentServerClient({
        url: fake.url,
        apiKey: API_KEY,
        retryDelayMs: 5,
        ...options?.client,
      }),
      remoteRoot,
      approveCommand: async () => true,
      pollIntervalMs: 10,
      ...(options?.limits ? { limits: options.limits } : {}),
    });
  } catch (error) {
    await fake.stop();
    await rm(base, { recursive: true, force: true });
    throw error;
  }
  return {
    provider,
    artifacts,
    fake,
    base,
    remoteRoot,
    async tamper(_context, workspace, path, content) {
      await writeFile(
        join(remoteRoot, "ws", workspace.workspace_id, "tree", path),
        content,
      );
    },
    async close() {
      await provider.close();
      await fake.stop();
      await rm(base, { recursive: true, force: true });
    },
  };
}
