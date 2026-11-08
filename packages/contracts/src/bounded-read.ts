/**
 * Size-capped strict UTF-8 reader for workbench RPC responses, shared by the
 * shell and VS Code transports so both enforce the same byte bound and reject
 * the same malformed bodies. Callers map {@link BoundedReadError} to their own
 * error type; stream read failures propagate unchanged.
 */

export type BoundedReadFailure = "too_large" | "malformed";

export class BoundedReadError extends Error {
  constructor(readonly failure: BoundedReadFailure) {
    super(
      failure === "too_large"
        ? "Response is too large."
        : "Response is not valid UTF-8.",
    );
    this.name = "BoundedReadError";
  }
}

export interface BoundedReadable {
  headers: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
  arrayBuffer?(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

function decodeStrict(
  decoder: TextDecoder,
  bytes?: Uint8Array,
  stream = false,
): string {
  try {
    return decoder.decode(bytes, { stream });
  } catch {
    throw new BoundedReadError("malformed");
  }
}

/**
 * Reads `response` as UTF-8, failing with `too_large` as soon as the declared
 * or received byte count exceeds `maxBytes` and with `malformed` on invalid
 * UTF-8. A body without a stream or `arrayBuffer` (injected test fetches) is
 * read with `text()` and bounded by its UTF-8 byte length.
 */
export async function readBoundedUtf8(
  response: BoundedReadable,
  maxBytes: number,
): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new BoundedReadError("too_large");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  if (!response.body) {
    if (!response.arrayBuffer) {
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > maxBytes)
        throw new BoundedReadError("too_large");
      return text;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new BoundedReadError("too_large");
    return decodeStrict(decoder, bytes);
  }
  const reader = response.body.getReader();
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new BoundedReadError("too_large");
      }
      text += decodeStrict(decoder, value, true);
    }
    return text + decodeStrict(decoder);
  } finally {
    reader.releaseLock();
  }
}
