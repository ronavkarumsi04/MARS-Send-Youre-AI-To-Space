import type { VerifiedArtifact } from "./client";

const TEXT_TYPES =
  /^(text\/|application\/(json|x-ndjson|xml|yaml|x-yaml|javascript|x-diff|x-patch)\b)/i;

export type ArtifactText =
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "binary" }
  | { kind: "invalid_utf8" };

/**
 * The one text policy for artifacts, shared by the side panel and the
 * editor: only TEXT_TYPES media types are text, and the first `maxBytes` must
 * be strict UTF-8. A character split by the `maxBytes` cut is dropped; any
 * other malformed byte means the artifact is not text.
 */
export function decodeArtifactText(
  artifact: Pick<VerifiedArtifact, "media_type" | "bytes">,
  maxBytes = Number.POSITIVE_INFINITY,
): ArtifactText {
  if (!TEXT_TYPES.test(artifact.media_type)) return { kind: "binary" };
  const truncated = artifact.bytes.byteLength > maxBytes;
  const slice = artifact.bytes.subarray(0, maxBytes);
  try {
    // `stream` leaves only a sequence cut off at the end pending; every
    // malformed byte before the cut still throws.
    const text = new TextDecoder("utf-8", { fatal: true }).decode(slice, {
      stream: truncated,
    });
    return { kind: "text", text, truncated };
  } catch {
    return { kind: "invalid_utf8" };
  }
}
