export function startStatefulMcpServer(
  toolNames: string[] | ((identity: string | null) => string[]) = ["ping"],
) {
  const sessions = new Map<string, string | null>();
  const deleted: Array<{ id: string; identity: string | null }> = [];
  const calls: Array<{ id: string; identity: string | null }> = [];
  let nextId = 0;
  let invalidSessionRequests = 0;
  let redirectRequests = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (new URL(request.url).pathname === "/redirect") {
        redirectRequests++;
        return new Response(null, { status: 200 });
      }
      const identity = request.headers.get("authorization");
      const id = request.headers.get("mcp-session-id");
      const rpc =
        request.method === "POST"
          ? ((await request.json()) as { id?: number; method: string })
          : undefined;
      const result = (value: unknown, headers?: HeadersInit) =>
        Response.json(
          { jsonrpc: "2.0", id: rpc?.id, result: value },
          headers ? { headers } : undefined,
        );

      if (rpc?.method === "initialize" && id === null) {
        const newId = String(++nextId);
        sessions.set(newId, identity);
        return result(
          {
            protocolVersion: "2025-03-26",
            serverInfo: { name: "stateful", version: "1.0.0" },
            capabilities: { tools: {} },
          },
          { "Mcp-Session-Id": newId },
        );
      }
      if (!id || !sessions.has(id) || sessions.get(id) !== identity) {
        invalidSessionRequests++;
        return new Response(null, { status: 403 });
      }
      if (request.method === "DELETE") {
        sessions.delete(id);
        deleted.push({ id, identity });
        return new Response(null, {
          status: 307,
          headers: { Location: "/redirect" },
        });
      }
      switch (rpc?.method) {
        case "notifications/initialized":
          return new Response(null, { status: 202 });
        case "tools/list":
          return result({
            tools: (typeof toolNames === "function"
              ? toolNames(identity)
              : toolNames
            ).map((name) => ({ name, inputSchema: { type: "object" } })),
          });
        case "tools/call":
          calls.push({ id, identity });
          return result({ content: [{ type: "text", text: "pong" }] });
        default:
          return new Response(null, { status: 404 });
      }
    },
  });
  return {
    server,
    sessions,
    calls,
    deleted,
    get invalidSessionRequests() {
      return invalidSessionRequests;
    },
    get redirectRequests() {
      return redirectRequests;
    },
  };
}
