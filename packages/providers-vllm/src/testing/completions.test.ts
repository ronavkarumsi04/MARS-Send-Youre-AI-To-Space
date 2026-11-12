import { expect, test } from "bun:test";
import { startFakeVllm } from "../index";

test("fake completions are opt-in and count as model requests", async () => {
  for (const enabled of [false, true]) {
    const fake = startFakeVllm(enabled ? { completions: () => "answer" } : {});
    try {
      const response = await fetch(`${fake.url}/v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ model: "mars-base" }),
      });
      expect(response.status).toBe(enabled ? 200 : 500);
      if (enabled)
        expect((await response.json()).choices[0].message.content).toBe(
          "answer",
        );
      expect(fake.modelRequests()).toHaveLength(1);
    } finally {
      await fake.stop();
    }
  }
});
