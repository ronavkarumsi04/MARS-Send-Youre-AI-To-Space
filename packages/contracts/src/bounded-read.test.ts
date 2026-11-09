import { describe, expect, test } from "bun:test";
import {
  type BoundedReadable,
  BoundedReadError,
  readBoundedUtf8,
} from "./bounded-read";

const noHeaders = { get: () => null };

function streamed(
  chunks: Uint8Array[],
  onCancel: () => void = () => {},
): BoundedReadable {
  return {
    headers: noHeaders,
    text: () => Promise.reject(new Error("text() must not be used")),
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift();
        if (next) controller.enqueue(next);
        else controller.close();
      },
      cancel: onCancel,
    }),
  };
}

async function failureOf(run: Promise<unknown>): Promise<string | undefined> {
  try {
    await run;
  } catch (error) {
    return error instanceof BoundedReadError ? error.failure : "other";
  }
  return undefined;
}

describe("readBoundedUtf8", () => {
  test("decodes streamed multi-byte text split across chunks", async () => {
    const bytes = new TextEncoder().encode('{"result":"héllo"}');
    expect(
      await readBoundedUtf8(
        streamed([bytes.slice(0, 13), bytes.slice(13)]),
        64,
      ),
    ).toBe('{"result":"héllo"}');
  });

  test("cancels the stream once received bytes exceed the bound", async () => {
    let cancelled = false;
    const chunk = new Uint8Array(1024).fill(0x20);
    const response = streamed([chunk, chunk, chunk], () => {
      cancelled = true;
    });
    expect(await failureOf(readBoundedUtf8(response, 2048))).toBe("too_large");
    expect(cancelled).toBe(true);
  });

  test("rejects a declared content-length above the bound before reading", async () => {
    const response: BoundedReadable = {
      headers: { get: (name) => (name === "content-length" ? "100" : null) },
      text: () => Promise.reject(new Error("body must not be read")),
    };
    expect(await failureOf(readBoundedUtf8(response, 99))).toBe("too_large");
  });

  test("rejects invalid UTF-8 in streamed and buffered bodies", async () => {
    const invalid = new Uint8Array([0x7b, 0xff, 0x7d]);
    expect(await failureOf(readBoundedUtf8(streamed([invalid]), 64))).toBe(
      "malformed",
    );
    const truncated = new TextEncoder().encode("é").slice(0, 1);
    expect(await failureOf(readBoundedUtf8(streamed([truncated]), 64))).toBe(
      "malformed",
    );
    const buffered: BoundedReadable = {
      headers: noHeaders,
      arrayBuffer: () => Promise.resolve(invalid.buffer),
      text: () => Promise.reject(new Error("text() must not be used")),
    };
    expect(await failureOf(readBoundedUtf8(buffered, 64))).toBe("malformed");
  });

  test("cancels the stream when a chunk is not valid UTF-8", async () => {
    let cancelled = false;
    const response = streamed(
      [new Uint8Array([0x7b, 0xff]), new Uint8Array(16).fill(0x20)],
      () => {
        cancelled = true;
      },
    );
    expect(await failureOf(readBoundedUtf8(response, 64))).toBe("malformed");
    expect(cancelled).toBe(true);
  });

  test("bounds buffered and text-only bodies by UTF-8 bytes, not characters", async () => {
    const text = "é".repeat(40);
    const bytes = new TextEncoder().encode(text);
    const buffered: BoundedReadable = {
      headers: noHeaders,
      arrayBuffer: () => Promise.resolve(bytes.buffer),
      text: () => Promise.reject(new Error("text() must not be used")),
    };
    const textOnly: BoundedReadable = {
      headers: noHeaders,
      text: () => Promise.resolve(text),
    };
    expect(await failureOf(readBoundedUtf8(buffered, 79))).toBe("too_large");
    expect(await failureOf(readBoundedUtf8(textOnly, 79))).toBe("too_large");
    expect(await readBoundedUtf8(buffered, 80)).toBe(text);
    expect(await readBoundedUtf8(textOnly, 80)).toBe(text);
  });

  test("stream read failures propagate unchanged", async () => {
    const boom = new Error("socket reset");
    const response: BoundedReadable = {
      headers: noHeaders,
      text: () => Promise.reject(new Error("text() must not be used")),
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(boom);
        },
      }),
    };
    await expect(readBoundedUtf8(response, 64)).rejects.toBe(boom);
  });
});
