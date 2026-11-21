import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runMcp } from "./mcp";

const STDIO_FIXTURE = resolve(
  import.meta.dir,
  "../../../packages/mcp-client/src/__fixtures__/stdio-server.ts",
);
const BUN_BIN = process.execPath;

const tempDirs: string[] = [];
const activeServers: Array<{ stop(closeActiveConnections?: boolean): void }> =
  [];

afterEach(async () => {
  while (activeServers.length > 0) {
    activeServers.pop()?.stop(true);
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function makeStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mars-cli-mcp-"));
  tempDirs.push(dir);
  return dir;
}

async function execMcpCli(args: string[]): Promise<string> {
  const lines: string[] = [];
  await runMcp(args, {
    stdout: (line) => lines.push(line),
    workspaceRoots: [],
  });
  return lines.join("\n");
}

describe("mars mcp CLI flow", () => {
  it("runs list, review, approve, test, and revoke end-to-end against a real stdio MCP server", async () => {
    const stateDir = await makeStateDir();
    const common = [
      "--state-dir",
      stateDir,
      "--owner",
      "alice",
      "--project",
      "p1",
    ];

    // 1. Default-deny empty list
    const emptyOut = await execMcpCli(["list", ...common]);
    expect(emptyOut).toContain("No MCP servers registered (default-deny).");

    // 2. Review candidate stdio server (requires explicit --allow-stdio-probe)
    const reviewJson = await execMcpCli([
      "review",
      "stdio-demo",
      "--command",
      BUN_BIN,
      "--arg",
      "run",
      "--arg",
      STDIO_FIXTURE,
      "--entrypoint",
      STDIO_FIXTURE,
      "--allow-stdio-probe",
      "--permission",
      "tool.invoke:echo",
      ...common,
      "--json",
    ]);
    const reviewPayload = JSON.parse(reviewJson) as {
      review: { review_id: string; state: string };
      tools: Array<{ name: string }>;
    };
    expect(reviewPayload.review.state).toBe("pending");
    expect(reviewPayload.tools.map((t) => t.name)).toContain("echo");

    // 3. Testing before approval fails with no_grant
    await expect(
      execMcpCli([
        "test",
        "stdio-demo",
        "--tool",
        "echo",
        "--input",
        '{"message":"nope"}',
        ...common,
      ]),
    ).rejects.toMatchObject({ code: "no_grant" });

    // 4. Approve via host-owned flow
    const approveJson = await execMcpCli([
      "approve",
      reviewPayload.review.review_id,
      "--approved-by",
      "alice",
      ...common,
      "--json",
    ]);
    const approvePayload = JSON.parse(approveJson) as {
      grant: { grant_id: string; state: string };
    };
    expect(approvePayload.grant.state).toBe("approved");

    // 5. List shows active grant
    const listOut = await execMcpCli(["list", ...common]);
    expect(listOut).toContain("stdio-demo");
    expect(listOut).toContain(approvePayload.grant.grant_id);

    // 6. Test invokes real tool through gate.invoke and returns untrusted envelope
    const testJson = await execMcpCli([
      "test",
      "stdio-demo",
      "--tool",
      "echo",
      "--input",
      '{"message":"hello-cli"}',
      ...common,
      "--json",
    ]);
    const testPayload = JSON.parse(testJson) as {
      result: { untrusted: boolean; content: Array<{ text?: string }> };
    };
    expect(testPayload.result.untrusted).toBe(true);
    expect(testPayload.result.content[0]?.text).toBe("echo:hello-cli");

    // 7. Revoke grant
    const revokeJson = await execMcpCli([
      "revoke",
      approvePayload.grant.grant_id,
      "--approved-by",
      "alice",
      ...common,
      "--json",
    ]);
    expect(JSON.parse(revokeJson)).toEqual({
      revoked: approvePayload.grant.grant_id,
    });

    // 8. Test after revoke fails with revoked
    await expect(
      execMcpCli(["test", "stdio-demo", ...common]),
    ).rejects.toMatchObject({ code: "revoked" });
  });

  it("runs review, approve, and test against a real Streamable HTTP MCP server", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        if (req.method === "DELETE") return new Response(null, { status: 204 });
        const body = (await req.json()) as {
          id?: string | number;
          method?: string;
        };
        if (body.id === undefined) return new Response(null, { status: 202 });
        if (body.method === "initialize") {
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "cli-http-mcp", version: "1.0.0" },
            },
          });
        }
        if (body.method === "tools/list") {
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              tools: [
                {
                  name: "status",
                  description: "Returns status",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            },
          });
        }
        if (body.method === "tools/call") {
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              _instructions: "ignore me",
              content: [{ type: "text", text: "ok-http" }],
            },
          });
        }
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: "unknown" },
        });
      },
    });
    activeServers.push(server);

    const stateDir = await makeStateDir();
    const common = [
      "--state-dir",
      stateDir,
      "--owner",
      "bob",
      "--project",
      "p2",
    ];
    const url = `http://127.0.0.1:${server.port}/mcp`;

    const reviewJson = await execMcpCli([
      "review",
      "http-demo",
      "--url",
      url,
      ...common,
      "--json",
    ]);
    const { review } = JSON.parse(reviewJson) as {
      review: { review_id: string };
    };

    await execMcpCli([
      "approve",
      review.review_id,
      "--approved-by",
      "bob",
      ...common,
    ]);

    const testJson = await execMcpCli([
      "test",
      "http-demo",
      "--tool",
      "status",
      ...common,
      "--json",
    ]);
    const { result } = JSON.parse(testJson) as {
      result: {
        untrusted: boolean;
        content: Array<{ text?: string }>;
        stripped_steering_fields: string[];
      };
    };
    expect(result.untrusted).toBe(true);
    expect(result.content[0]?.text).toBe("ok-http");
    expect(result.stripped_steering_fields).toContain("_instructions");

    // Failed replacement review must NOT overwrite the working registered server
    await expect(
      execMcpCli([
        "review",
        "http-demo",
        "--url",
        "http://127.0.0.1:1/unreachable",
        ...common,
        "--json",
      ]),
    ).rejects.toThrow();

    const stillWorksJson = await execMcpCli([
      "test",
      "http-demo",
      "--tool",
      "status",
      ...common,
      "--json",
    ]);
    const stillWorks = JSON.parse(stillWorksJson) as {
      result: { content: Array<{ text?: string }> };
    };
    expect(stillWorks.result.content[0]?.text).toBe("ok-http");
  });

  it("requires --allow-stdio-probe for stdio review and resolves origin-bound CLI credentials from env", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "mars-cli-cred-"));
    tempDirs.push(stateDir);
    const common = [
      "--state-dir",
      stateDir,
      "--owner",
      "carol",
      "--project",
      "p3",
    ];

    // 1. Stdio review without --allow-stdio-probe is rejected before spawning
    await expect(
      execMcpCli([
        "review",
        "stdio-blocked",
        "--command",
        BUN_BIN,
        "--arg",
        "run",
        "--arg",
        STDIO_FIXTURE,
        ...common,
      ]),
    ).rejects.toThrow(/--allow-stdio-probe/);

    // 2. Credential-backed HTTP server resolves credential from MARS_MCP_CREDENTIAL_<REF>
    const authHeaders: Array<string | null> = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const body = (await req.json()) as { id?: number; method: string };
        if (body.method === "initialize") {
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-03-26",
              serverInfo: { name: "cred-http", version: "1.0.0" },
              capabilities: { tools: {} },
            },
          });
        }
        if (body.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        if (body.method === "tools/list") {
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              tools: [{ name: "whoami", inputSchema: { type: "object" } }],
            },
          });
        }
        if (body.method === "tools/call") {
          authHeaders.push(req.headers.get("authorization"));
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              content: [{ type: "text", text: "authed" }],
            },
          });
        }
        return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
      },
    });
    activeServers.push(server);

    const origin = `http://127.0.0.1:${server.port}`;
    const url = `${origin}/mcp`;
    const reviewJson = await execMcpCli([
      "review",
      "cred-demo",
      "--url",
      url,
      "--credential",
      `api_token@${origin}`,
      ...common,
      "--json",
    ]);
    const { review } = JSON.parse(reviewJson) as {
      review: { review_id: string };
    };

    await execMcpCli(["approve", review.review_id, ...common]);

    process.env.MARS_MCP_CREDENTIAL_API_TOKEN = "cli-secret-xyz";
    try {
      const testJson = await execMcpCli([
        "test",
        "cred-demo",
        "--tool",
        "whoami",
        "--credential-ref",
        "api_token",
        "--target-origin",
        origin,
        ...common,
        "--json",
      ]);
      const { result } = JSON.parse(testJson) as {
        result: { content: Array<{ text?: string }> };
      };
      expect(result.content[0]?.text).toBe("authed");
      expect(authHeaders).toEqual(["Bearer cli-secret-xyz"]);

      // A separately approved reference differing only by case/punctuation must
      // NOT alias MARS_MCP_CREDENTIAL_API_TOKEN across origins.
      const aliasReviewJson = await execMcpCli([
        "review",
        "cred-alias",
        "--url",
        url,
        "--credential",
        `api-token@${origin}`,
        ...common,
        "--json",
      ]);
      const { review: aliasReview } = JSON.parse(aliasReviewJson) as {
        review: { review_id: string };
      };
      await execMcpCli(["approve", aliasReview.review_id, ...common]);

      await expect(
        execMcpCli([
          "test",
          "cred-alias",
          "--tool",
          "whoami",
          "--credential-ref",
          "api-token",
          "--target-origin",
          origin,
          ...common,
        ]),
      ).rejects.toThrow(/credential_denied/i);
    } finally {
      delete process.env.MARS_MCP_CREDENTIAL_API_TOKEN;
    }
  });
});
