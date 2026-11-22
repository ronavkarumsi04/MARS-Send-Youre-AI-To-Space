import { expect, test } from "bun:test";
import { createReconnectingBridge } from "../src/main/session";
import { createLoopbackTransport } from "../src/main/transport";
import { loadFixtureData } from "./test-utils";

function stalledBody() {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"result":'));
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

test("deadline while reading a stalled body is a timeout, not a protocol failure", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: stalledBody,
  });
  try {
    const transport = createLoopbackTransport({
      url: `http://127.0.0.1:${server.port}`,
      token: "fixture-token",
      timeoutMs: 100,
    });
    await expect(
      transport.send({ method: "tasks.list", params: {} }),
    ).rejects.toMatchObject({ kind: "timeout" });
  } finally {
    await server.stop(true);
  }
});

test("a timed-out mutation is not replayed and the next explicit call resolves the replaced endpoint", async () => {
  const data = await loadFixtureData();
  const oldMethods: string[] = [];
  const newMethods: string[] = [];
  const oldServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const { method } = (await request.json()) as { method: string };
      oldMethods.push(method);
      return method === "workbench.describe"
        ? Response.json({ result: data.describe })
        : stalledBody();
    },
  });
  const newServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const { method } = (await request.json()) as { method: string };
      newMethods.push(method);
      return Response.json({
        result: method === "workbench.describe" ? data.describe : data.tasks,
      });
    },
  });
  let port = oldServer.port;
  let resolutions = 0;
  const bridge = createReconnectingBridge({
    resolve: async () => {
      resolutions++;
      return {
        ok: true,
        connection: {
          url: `http://127.0.0.1:${port}`,
          token: "fixture-token",
          scope: data.describe.scope,
        },
      };
    },
    makeTransport: (connection) =>
      createLoopbackTransport({ ...connection, timeoutMs: 100 }),
  });
  try {
    expect(
      await bridge.call("tasks.cancel", { task_id: "fixture-running" }),
    ).toMatchObject({ ok: false, error: { kind: "timeout" } });
    expect(resolutions).toBe(1);
    expect(oldMethods).toEqual(["workbench.describe", "tasks.cancel"]);
    expect(newMethods).toEqual([]);
    port = newServer.port;
    expect(await bridge.call("tasks.list", {})).toMatchObject({
      ok: true,
      result: data.tasks,
    });
    expect(resolutions).toBe(2);
    expect(oldMethods).toEqual(["workbench.describe", "tasks.cancel"]);
    expect(newMethods).toEqual(["workbench.describe", "tasks.list"]);
  } finally {
    await oldServer.stop(true);
    await newServer.stop(true);
  }
});
