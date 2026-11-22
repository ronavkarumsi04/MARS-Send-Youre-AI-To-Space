import { expect, test } from "bun:test";
import type { LocalConnection } from "@mars/contracts/connection-file";
import { createReconnectingBridge } from "../src/main/session";
import {
  createLoopbackTransport,
  TransportError,
  type TransportRequest,
} from "../src/main/transport";
import { bridgeFailure } from "../src/shared/methods";
import { loadFixtureData } from "./test-utils";

const connection: LocalConnection = {
  url: "http://127.0.0.1:7331",
  token: "fixture-token-0123456789abcdefghijklmnopqrstuvwxyz",
  scope: { owner_id: "fixture-owner", project_id: "fixture-project" },
};

test("connection resolution retries after not_connected and reaches the workbench", async () => {
  const data = await loadFixtureData();
  let resolveCalls = 0;
  let transportCreations = 0;
  const requests: TransportRequest[] = [];
  const bridge = createReconnectingBridge({
    async resolve() {
      resolveCalls++;
      if (resolveCalls === 1)
        return {
          ok: false,
          reason:
            "No workbench connection file found. Start `mars serve` or pass --connection=PATH.",
        };
      return { ok: true, connection };
    },
    makeTransport() {
      transportCreations++;
      return {
        async send(request) {
          requests.push(request);
          if (request.method === "workbench.describe") return data.describe;
          if (request.method === "tasks.list") return data.tasks;
          throw new Error("Unexpected test request.");
        },
      };
    },
  });

  expect(await bridge.call("tasks.list", {})).toMatchObject({
    ok: false,
    error: { kind: "not_connected" },
  });
  expect(resolveCalls).toBe(1);
  expect(transportCreations).toBe(0);
  expect(await bridge.call("tasks.list", {})).toMatchObject({ ok: true });
  expect(resolveCalls).toBe(2);
  expect(transportCreations).toBe(1);
  expect(requests.map((request) => request.method)).toEqual([
    "workbench.describe",
    "tasks.list",
  ]);
});

test("unavailable, unauthorized and timeout failures trigger connection resolution again", async () => {
  const data = await loadFixtureData();
  for (const kind of ["unavailable", "unauthorized", "timeout"] as const) {
    let resolveCalls = 0;
    let transportCreations = 0;
    const bridge = createReconnectingBridge({
      async resolve() {
        resolveCalls++;
        return { ok: true, connection };
      },
      makeTransport() {
        transportCreations++;
        const instance = transportCreations;
        return {
          async send(request) {
            if (request.method === "workbench.describe") return data.describe;
            if (request.method === "tasks.list" && instance === 1)
              throw new TransportError(kind);
            if (request.method === "tasks.list") return data.tasks;
            throw new Error("Unexpected test request.");
          },
        };
      },
    });

    expect(await bridge.call("tasks.list", {})).toMatchObject({
      ok: false,
      error: { kind },
    });
    expect(await bridge.call("tasks.list", {})).toMatchObject({ ok: true });
    expect(resolveCalls).toBe(2);
    expect(transportCreations).toBe(2);
  }
});

test("a stalled mutation times out without replay and the next call uses the replacement endpoint", async () => {
  const { describe } = await loadFixtureData();
  const calls: string[] = [];
  function endpoint(label: string) {
    return Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const { method } = (await request.json()) as TransportRequest;
        calls.push(`${label}:${method}`);
        if (method === "tasks.cancel") {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"result":'));
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return Response.json({
          result: { ...describe, workspaceLabel: label },
        });
      },
    });
  }

  const old = endpoint("old");
  const replacement = endpoint("replacement");
  try {
    let url = old.url.origin;
    const bridge = createReconnectingBridge({
      resolve: async () => ({ ok: true, connection: { ...connection, url } }),
      makeTransport: (resolved) =>
        createLoopbackTransport({ ...resolved, timeoutMs: 500 }),
    });
    const mutation = await bridge.call("tasks.cancel", {
      task_id: "fixture-running",
    });
    expect(calls).toEqual(["old:workbench.describe", "old:tasks.cancel"]);

    url = replacement.url.origin;
    const next = await bridge.call("workbench.describe", {});
    expect({ mutation, next, calls }).toMatchObject({
      mutation: bridgeFailure("timeout"),
      next: { ok: true, result: { workspaceLabel: "replacement" } },
      calls: [
        "old:workbench.describe",
        "old:tasks.cancel",
        "replacement:workbench.describe",
      ],
    });
  } finally {
    await Promise.all([old.stop(true), replacement.stop(true)]);
  }
});

test("a refused method does not resolve a connection", async () => {
  let resolveCalls = 0;
  const bridge = createReconnectingBridge({
    async resolve() {
      resolveCalls++;
      return { ok: false, reason: "No connection." };
    },
    makeTransport() {
      throw new Error("Unexpected transport creation.");
    },
  });

  expect(await bridge.call("tasks.checkpoint", {})).toMatchObject({
    ok: false,
    error: { kind: "refused" },
  });
  expect(resolveCalls).toBe(0);
});

test("connection failures use the shared not_connected message", async () => {
  const bridge = createReconnectingBridge({
    async resolve() {
      throw new Error("resolver crashed");
    },
    makeTransport() {
      throw new Error("Unexpected transport creation.");
    },
  });

  expect(await bridge.call("tasks.list", {})).toEqual(
    bridgeFailure("not_connected"),
  );
  expect(await bridge.call("tasks.checkpoint", {})).toEqual(
    bridgeFailure("refused"),
  );
});
