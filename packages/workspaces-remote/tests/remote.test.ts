import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryArtifactStore } from "@mars/workspaces";
import {
  assertRemotePath,
  createAgentServerClient,
  createRemoteWorkspaceProvider,
  ISOLATION_STATEMENT,
  startFakeAgentServer,
} from "../src";
import { context } from "./conformance";
import { API_KEY, makeSource, remoteFixture } from "./fixtures";

const budget = {
  max_tokens: 1,
  max_usd: 0,
  max_duration_ms: 10_000,
  max_depth: 1,
  max_concurrency: 1,
};
async function failure(
  promise: Promise<unknown>,
): Promise<Error & { code?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error("expected a failure");
}
const T = 30_000;

describe("remote provider robustness (FAKE Agent Server)", () => {
  test(
    "unknown server versions and foreign servers fail closed",
    async () => {
      const base = await mkdtemp(join(tmpdir(), "mars-remote-ver-"));
      const fake = await startFakeAgentServer({
        workingDir: join(base, "remote"),
        version: "9.9.9",
      });
      const foreign = await startFakeAgentServer({
        workingDir: join(base, "remote2"),
        title: "Something Else",
      });
      try {
        const make = (url: string) =>
          createRemoteWorkspaceProvider({
            rootDir: join(base, "state"),
            sourceRoot: base,
            artifacts: createInMemoryArtifactStore(),
            client: createAgentServerClient({ url }),
            remoteRoot: join(base, "remote"),
          });
        const versionError = await failure(make(fake.url));
        expect(versionError.code).toBe("sandbox_unavailable");
        expect(versionError.message).toContain(
          "Unsupported Agent Server version",
        );
        expect((await failure(make(foreign.url))).message).toContain(
          "does not identify",
        );
      } finally {
        await fake.stop();
        await foreign.stop();
        await rm(base, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "a command start whose response is lost is never retried",
    async () => {
      const fx = await remoteFixture();
      try {
        const ws = await fx.provider.prepare(context, "task-lost");
        fx.fake.faults.loseStartResponse = true;
        const error = await failure(
          fx.provider.execute(
            context,
            ws,
            ["sh", "-c", "echo once >> count.txt"],
            budget,
          ),
        );
        expect(error.code).toBe("sandbox_unavailable");
        expect(
          fx.fake
            .startedCommands()
            .filter((command) => command.includes("count.txt")),
        ).toHaveLength(1);
        const after = await fx.provider.inspect(context, ws.workspace_id);
        const read = await fx.provider.read(context, after, "count.txt");
        expect(
          new TextDecoder().decode(await fx.artifacts.get(context, read)),
        ).toBe("once\n");
      } finally {
        await fx.close();
      }
    },
    T,
  );

  test(
    "idempotent reads are retried on transient 5xx",
    async () => {
      const fx = await remoteFixture();
      try {
        const ws = await fx.provider.prepare(context, "task-retry");
        fx.fake.faults.failNext.set("/api/bash/bash_events/search", {
          status: 503,
          count: 2,
        });
        fx.fake.faults.failNext.set("/api/file/download", {
          status: 502,
          count: 1,
        });
        const result = await fx.provider.execute(
          context,
          ws,
          ["echo", "ok"],
          budget,
        );
        expect(result.exit_code).toBe(0);
        expect(
          await fx.provider.read(context, result.workspace, "README.md"),
        ).toBeTruthy();
        expect(
          fx.fake.faults.failNext.get("/api/bash/bash_events/search")?.count,
        ).toBe(0);
        expect(fx.fake.faults.failNext.get("/api/file/download")?.count).toBe(
          0,
        );
      } finally {
        await fx.close();
      }
    },
    T,
  );

  test(
    "credentials are sent only as the session header and never surface in errors",
    async () => {
      const fx = await remoteFixture();
      try {
        expect(
          fx.fake.log
            .filter((entry) => entry.route.startsWith("/api/"))
            .every((entry) => entry.authed),
        ).toBe(true);
        const wrong = createAgentServerClient({
          url: fx.fake.url,
          apiKey: "wrong-key-value",
        });
        const refused = await failure(
          wrong.startCommand("true", fx.remoteRoot, 5),
        );
        expect(refused.message).toContain("authentication failed");
        expect(
          JSON.stringify([refused.message, String(refused.cause)]),
        ).not.toContain("wrong-key-value");
        const leaky = createAgentServerClient({
          url: "https://agent.invalid",
          apiKey: API_KEY,
          retries: 0,
          fetch: async () => {
            throw new Error(`connect failed with header ${API_KEY}`);
          },
        });
        const error = await failure(leaky.verify());
        expect(
          `${error.message} ${(error.cause as Error).message}`,
        ).not.toContain(API_KEY);
        expect((error.cause as Error).message).toContain("[redacted]");
      } finally {
        await fx.close();
      }
    },
    T,
  );

  test("transport policy: no clear-text keys to remote hosts, no URL credentials", () => {
    expect(() =>
      createAgentServerClient({ url: "http://agent.example:8000" }),
    ).toThrow("https");
    expect(() =>
      createAgentServerClient({ url: "https://user:pw@agent.example" }),
    ).toThrow("credentials");
    expect(
      createAgentServerClient({ url: "http://127.0.0.1:1" }).transport,
    ).toBe("http-loopback");
    expect(
      createAgentServerClient({
        url: "http://agent.example",
        allowInsecureHttp: true,
      }).transport,
    ).toBe("http-insecure");
  });

  test("remote paths are confined client-side", () => {
    for (const bad of ["relative", "/a/../b", "/a//b", "/a/./b", "/a/\nb", ""])
      expect(() => assertRemotePath(bad)).toThrow(
        "Invalid remote workspace path",
      );
    expect(assertRemotePath("/workspace/mars/ws/x")).toBe(
      "/workspace/mars/ws/x",
    );
  });

  test(
    "downloaded bytes are hash-checked",
    async () => {
      const fx = await remoteFixture();
      try {
        const ws = await fx.provider.prepare(context, "task-hash");
        fx.fake.faults.corruptDownloads = true;
        expect(
          (await failure(fx.provider.read(context, ws, "README.md"))).code,
        ).toBe("workspace_modified");
        const run = fx.provider.execute(
          context,
          ws,
          ["sh", "-c", "echo new > fresh.txt"],
          budget,
        );
        expect((await failure(run)).code).toBe("integrity");
      } finally {
        await fx.close();
      }
    },
    T,
  );

  test(
    "response bodies are bounded",
    async () => {
      const fx = await remoteFixture();
      try {
        const small = createAgentServerClient({
          url: fx.fake.url,
          apiKey: API_KEY,
          maxResponseBytes: 16,
        });
        expect((await failure(small.verify())).code).toBe("limit_exceeded");
      } finally {
        await fx.close();
      }
    },
    T,
  );

  test(
    "a host check that writes into the candidate is rejected",
    async () => {
      const fx = await remoteFixture();
      try {
        const ws = await fx.provider.prepare(context, "task-escape");
        const target = join(
          fx.remoteRoot,
          "ws",
          ws.workspace_id,
          "tree",
          "README.md",
        );
        const error = await failure(
          fx.provider.runCheck(context, ws, {
            argv: ["sh", "-c", `echo escaped > '${target}'`],
            overlay: [],
            timeoutMs: 5_000,
          }),
        );
        expect(error.code).toBe("integrity");
        expect(error.message).toContain("modified the remote candidate");
      } finally {
        await fx.close();
      }
    },
    T,
  );

  test(
    "an interrupted restore is rolled forward from its durable journal",
    async () => {
      const fx = await remoteFixture();
      try {
        const ws = await fx.provider.prepare(context, "task-journal");
        const baseline = (await fx.provider.checkpoints(context, ws))[0];
        if (!baseline) throw new Error("no baseline");
        const ref = await fx.artifacts.put(
          context,
          new TextEncoder().encode("edited\n"),
          "text/plain",
        );
        await fx.provider.remove(context, ws, "README.md");
        await fx.provider.write(context, ws, "src/a.ts", ref);
        const edited = await fx.provider.inspect(context, ws.workspace_id);
        fx.fake.faults.failNext.set("/api/file/upload", {
          status: 503,
          count: 100,
        });
        expect(
          (
            await failure(
              fx.provider.restore(context, baseline, edited.revision),
            )
          ).code,
        ).toBe("sandbox_unavailable");
        fx.fake.faults.failNext.clear();
        const recovered = await fx.provider.inspect(context, ws.workspace_id);
        expect(recovered.revision.split(".")[1]).toBe(
          ws.revision.split(".")[1],
        );
        expect((await fx.provider.diff(context, recovered)).files).toEqual([]);
      } finally {
        await fx.close();
      }
    },
    T,
  );

  test(
    "one provider process holds the store lease",
    async () => {
      const fx = await remoteFixture();
      try {
        const second = await failure(
          createRemoteWorkspaceProvider({
            rootDir: join(fx.base, "state"),
            sourceRoot: await makeSource(join(fx.base, "other")),
            artifacts: fx.artifacts,
            client: createAgentServerClient({
              url: fx.fake.url,
              apiKey: API_KEY,
            }),
            remoteRoot: fx.remoteRoot,
          }),
        );
        expect(second.name).toBe("ProviderLockedError");
      } finally {
        await fx.close();
      }
    },
    T,
  );

  test(
    "isolation is reported as none, with the server's claim kept untrusted",
    async () => {
      const fx = await remoteFixture();
      try {
        const report = fx.provider.isolation();
        expect(report.os_isolation).toBe("none");
        expect(report.statement).toBe(ISOLATION_STATEMENT);
        expect(report.statement).toContain("not an OS isolation guarantee");
        expect(report.untrusted_server_runtime).toBe("local");
        expect(report.authenticated).toBe(true);
        expect(report.pinned_revision).toBe(
          "c048a1eb82353b0586f3ce600708394a68ebb246",
        );
        expect(JSON.stringify(report)).not.toContain(API_KEY);
      } finally {
        await fx.close();
      }
    },
    T,
  );
});
