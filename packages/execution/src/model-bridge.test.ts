import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadModelRegistry } from "@mars/providers";
import type { Model } from "@oh-my-pi/pi-ai";
import {
  createModelBridge,
  NoEligibleModelError,
  selectExecutionModel,
  toChatRequest,
} from "./model-bridge";

test("model selection rejects an unknown model with a typed configuration-free error", async () => {
  const registry = await loadModelRegistry({
    cwd: "/nonexistent-model-selection",
    home: "/nonexistent-model-selection",
    env: {},
  });
  expect(() => selectExecutionModel(registry, "private-model-name")).toThrow(
    NoEligibleModelError,
  );
});

async function fixture(
  pricing = { free: true, inputPerMTokUsd: 0, outputPerMTokUsd: 0 },
) {
  const root = await mkdtemp("/tmp/mars-bridge-test-");
  await mkdir(join(root, ".mars"));
  await writeFile(
    join(root, ".mars/models.json"),
    JSON.stringify({
      version: 1,
      providers: [
        {
          id: "fixture",
          kind: "openai-compatible",
          baseUrl: "https://fixture.invalid/v1",
          apiKeyEnv: "MARS_FIXTURE_KEY",
        },
      ],
      models: [
        {
          id: "fixture/model",
          providerId: "fixture",
          model: "stub",
          capabilities: { tools: true, vision: false, contextWindow: 32000 },
          pricing,
        },
      ],
      routes: { default: ["fixture/model"] },
      policy: { allowPaid: true },
    }),
  );
  const env = { MARS_FIXTURE_KEY: "dummy-not-a-secret" };
  const registry = await loadModelRegistry({ cwd: root, home: root, env });
  const selected = registry.getModel("fixture/model");
  if (!selected) throw new Error("Missing fixture model");
  return {
    registry,
    env,
    selected,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function sse(deltas: Record<string, unknown>[]) {
  return new Response(
    `${[
      ...deltas.map((delta) => ({ choices: [{ delta, finish_reason: null }] })),
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 50, completion_tokens: 1 },
      },
    ]
      .map((row) => `data: ${JSON.stringify(row)}\n\n`)
      .join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

const model = { api: "fixture", provider: "fixture", id: "stub" } as Model;
const context = {
  messages: [{ role: "user" as const, content: "hello", timestamp: 1 }],
};
const budget = {
  max_tokens: 20000,
  max_usd: 0,
  max_duration_ms: 60000,
  max_depth: 1,
  max_concurrency: 1,
};
const ledger = () => ({
  deadline: Date.now() + 60000,
  reserved_tokens: 0,
  reserved_usd: 0,
  input_tokens: 0,
  output_tokens: 0,
});
const call = (id: string, name: string, args: unknown) => ({
  tool_calls: [
    {
      index: Number(id.slice(1)),
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});

test("aggregate output bounds text and all tool metadata before emitting any calls", async () => {
  const f = await fixture();
  try {
    for (const deltas of [
      [{ content: "x".repeat(1000) }],
      [call("c0", "write", { content: "x".repeat(1000) })],
      [call("c0", "x".repeat(1000), {})],
      [call("c" + "0".repeat(1000), "write", {})],
      [call("c0", "write", {}), call("c1", "write", {})],
      [call("c0", "w", {}), { content: "x".repeat(1000) }],
    ]) {
      const failures: string[] = [];
      const bridge = createModelBridge({
        ...f,
        budget,
        ledger: ledger(),
        signal: new AbortController().signal,
        persistLedger: async () => {},
        onFailure: (code) => failures.push(code),
        fetch: async () => sse(deltas),
      });
      const stream = bridge(model, context, { maxTokens: 1 });
      const events: string[] = [];
      for await (const event of stream) events.push(event.type);
      expect((await stream.result()).stopReason).toBe("error");
      expect(failures).toEqual(["budget_exhausted"]);
      expect(events.some((type) => type.startsWith("toolcall"))).toBe(false);
      expect(
        (await stream.result()).content.some(
          (part) => part.type === "toolCall",
        ),
      ).toBe(false);
    }
    for (const deltas of [[], [{ content: "OK" }], [call("c0", "w", {})]]) {
      const bridge = createModelBridge({
        ...f,
        budget,
        ledger: ledger(),
        signal: new AbortController().signal,
        persistLedger: async () => {},
        fetch: async () => sse(deltas),
      });
      expect(
        (await bridge(model, context, { maxTokens: 10 }).result()).stopReason,
      ).not.toBe("error");
    }
  } finally {
    await f.cleanup();
  }
});

test("USD capacity clamps output, supports zero output price, and refuses unaffordable input", async () => {
  for (const outputPerMTokUsd of [2, 0]) {
    const f = await fixture({
      free: false,
      inputPerMTokUsd: 1,
      outputPerMTokUsd,
    });
    try {
      for (const maxUsd of [0.002, 0]) {
        const requests: { max_tokens: number }[] = [];
        const state = ledger();
        const failures: string[] = [];
        const bridge = createModelBridge({
          ...f,
          budget: { ...budget, max_usd: maxUsd },
          ledger: state,
          signal: new AbortController().signal,
          persistLedger: async () => {},
          onFailure: (code) => failures.push(code),
          fetch: async (_url, init) => {
            requests.push(JSON.parse(String(init?.body)));
            return sse([{ content: "OK" }]);
          },
        });
        const result = await bridge(model, context).result();
        if (maxUsd === 0) {
          expect(result.stopReason).toBe("error");
          expect(failures).toEqual(["budget_exhausted"]);
          expect(requests).toHaveLength(0);
        } else {
          expect(result.stopReason).toBe("stop");
          expect(requests).toHaveLength(1);
          const request = requests[0];
          if (!request) throw new Error("Missing fixture request");
          expect(request.max_tokens).toBeGreaterThan(0);
          expect(request.max_tokens).toBe(
            outputPerMTokUsd === 0
              ? 4096
              : Math.floor(
                  ((maxUsd - (state.reserved_tokens - 1) / 1000000) * 1000000) /
                    outputPerMTokUsd,
                ),
          );
          expect(state.reserved_usd).toBeLessThanOrEqual(maxUsd);
        }
      }
    } finally {
      await f.cleanup();
    }
  }
});

test("USD clamp dispatches an exact one-token fit but rejects genuinely insufficient USD", async () => {
  const f = await fixture({
    free: false,
    inputPerMTokUsd: 1,
    outputPerMTokUsd: 0.3,
  });
  const inputAllowance =
    Buffer.byteLength(JSON.stringify(toChatRequest(context)), "utf8") + 512;
  try {
    for (const reservedUsd of [0, 0.1]) {
      for (const affordableTokens of [1, 0.9]) {
        const requests: { max_tokens: number }[] = [];
        const failures: string[] = [];
        const bridge = createModelBridge({
          ...f,
          budget: {
            ...budget,
            max_usd:
              reservedUsd +
              (inputAllowance + affordableTokens * 0.3) / 1_000_000,
          },
          ledger: { ...ledger(), reserved_usd: reservedUsd },
          signal: new AbortController().signal,
          persistLedger: async () => {},
          onFailure: (code) => failures.push(code),
          fetch: async (_url, init) => {
            requests.push(JSON.parse(String(init?.body)));
            return sse([{ content: "OK" }]);
          },
        });
        const result = await bridge(model, context).result();
        if (affordableTokens === 1) {
          expect(result.stopReason).toBe("stop");
          expect(requests).toEqual([{ ...requests[0], max_tokens: 1 }]);
          expect(failures).toEqual([]);
        } else {
          expect(result.stopReason).toBe("error");
          expect(requests).toEqual([]);
          expect(failures).toEqual(["budget_exhausted"]);
        }
      }
    }
  } finally {
    await f.cleanup();
  }
});

test("split surrogate pairs use final UTF-8 text bytes plus tool-call bytes", async () => {
  const f = await fixture();
  try {
    for (const withTool of [false, true]) {
      for (const overflow of [false, true]) {
        const prefix = "x".repeat(withTool ? 7 : 12);
        const deltas = [
          { content: prefix },
          { content: "\ud83d" },
          { content: "\ude00" },
          ...(withTool ? [call("c0", "w", {})] : []),
          ...(overflow ? [{ content: "!" }] : []),
        ];
        const failures: string[] = [];
        const bridge = createModelBridge({
          ...f,
          budget,
          ledger: ledger(),
          signal: new AbortController().signal,
          persistLedger: async () => {},
          onFailure: (code) => failures.push(code),
          fetch: async () => sse(deltas),
        });
        const stream = bridge(model, context, { maxTokens: 1 });
        const events: string[] = [];
        for await (const event of stream) events.push(event.type);
        const result = await stream.result();
        expect(result.stopReason).toBe(
          overflow ? "error" : withTool ? "toolUse" : "stop",
        );
        expect(failures).toEqual(overflow ? ["budget_exhausted"] : []);
        expect(events.includes("toolcall_end")).toBe(withTool && !overflow);
      }
    }
  } finally {
    await f.cleanup();
  }
});
