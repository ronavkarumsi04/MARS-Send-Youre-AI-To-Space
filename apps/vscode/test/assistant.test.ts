import { describe, expect, test } from "bun:test";
import { Assistant, freeCompletion } from "../src/assistant";
import {
  AssistantRequestSchema,
  type AssistantSession,
} from "../src/assistantMessages";

const id = "6bd9a588-99e7-43ba-a674-840def2cb887";
const send = {
  type: "assistantSend",
  id,
  text: "Help me plan",
  consent: true,
} as const;

describe("assistant", () => {
  test("requires explicit consent and rejects model or endpoint overrides", () => {
    expect(
      AssistantRequestSchema.safeParse({ ...send, consent: false }).success,
    ).toBe(false);
    expect(
      AssistantRequestSchema.safeParse({ ...send, model: "paid" }).success,
    ).toBe(false);
    expect(
      AssistantRequestSchema.safeParse({ ...send, url: "https://example.test" })
        .success,
    ).toBe(false);
  });

  test("requires a key and saves only completed conversations", async () => {
    let key: string | undefined;
    let sessions: AssistantSession[] = [];
    let calls = 0;
    const assistant = new Assistant({
      getKey: async () => key,
      read: () => sessions,
      save: async (next) => {
        sessions = next;
      },
      complete: async (messages) => {
        calls++;
        if (calls === 2) throw new Error("private provider response");
        return `Reply to: ${messages[0]?.content}`;
      },
    });
    expect(await assistant.send(send)).toMatchObject({
      configured: false,
      completesSend: true,
    });
    expect(calls).toBe(0);
    key = "test-only";
    expect(await assistant.send(send)).toMatchObject({
      configured: true,
      completesSend: true,
    });
    expect(sessions[0]?.messages.map(({ content }) => content)).toEqual([
      "Help me plan",
      "Reply to: Help me plan",
    ]);
    const failed = await assistant.send({ ...send, text: "Retry this" });
    expect(failed.error).toContain("Your draft is kept");
    expect(failed.error).not.toContain("private provider response");
    expect(sessions[0]?.messages).toHaveLength(2);
  });

  test("sends only the conversation to the fixed free route and never follows redirects", async () => {
    const fakeFetch: typeof fetch = Object.assign(
      async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
        expect(init?.redirect).toBe("error");
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe("openrouter/free");
        expect(body.tools).toBeUndefined();
        expect(body.messages.at(-1)).toEqual({ role: "user", content: "Hi" });
        return Response.json({ choices: [{ message: { content: "Hello" } }] });
      },
      { preconnect: () => {} },
    );
    expect(
      await freeCompletion(
        [{ role: "user", content: "Hi" }],
        "test-only",
        fakeFetch,
      ),
    ).toBe("Hello");
  });
});
