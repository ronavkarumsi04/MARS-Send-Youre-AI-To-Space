import type { VerifiedArtifact } from "./client";

const TEXT_TYPES =
  /^(text\/|application\/(json|x-ndjson|xml|yaml|x-yaml|javascript|x-diff|x-patch)\b)/i;

export type ArtifactText =
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "binary" }
  | { kind: "invalid_utf8" };

/**
 * The one text policy for artifacts, shared by the side panel and the
 * editor: only TEXT_TYPES media types are text, decoded as strict UTF-8 over
 * the first `maxBytes`; a cut that splits a character falls back to lossy
 * decoding, while invalid bytes inside an uncut artifact mean it is not text.
 */
export function decodeArtifactText(
  artifact: Pick<VerifiedArtifact, "media_type" | "bytes">,
  maxBytes = Number.POSITIVE_INFINITY,
): ArtifactText {
  if (!TEXT_TYPES.test(artifact.media_type)) return { kind: "binary" };
  const truncated = artifact.bytes.byteLength > maxBytes;
  const slice = artifact.bytes.subarray(0, maxBytes);
  try {
    return {
      kind: "text",
      text: new TextDecoder("utf-8", { fatal: true }).decode(slice),
      truncated,
    };
  } catch {
    if (!truncated) return { kind: "invalid_utf8" };
    return {
      kind: "text",
      text: new TextDecoder("utf-8").decode(slice),
      truncated,
    };
  }
}
