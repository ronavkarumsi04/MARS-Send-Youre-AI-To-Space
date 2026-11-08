import { describe, expect, test } from "bun:test";
import { decodeArtifactText } from "../src/artifactText";
import type { VerifiedArtifact } from "../src/client";
import { artifactView } from "../src/controller";

const utf8 = (text: string) => new TextEncoder().encode(text);

function artifact(media_type: string, bytes: Uint8Array): VerifiedArtifact {
  return {
    ref: {
      artifact_id: "artifact-1",
      sha256: "0".repeat(64),
      media_type,
      byte_length: bytes.byteLength,
    },
    media_type,
    bytes,
  } as unknown as VerifiedArtifact;
}

describe("decodeArtifactText", () => {
  test("non-text media types are binary even when the bytes are UTF-8", () => {
    for (const type of ["image/svg+xml", "application/octet-stream"])
      expect(decodeArtifactText(artifact(type, utf8("<svg/>")))).toEqual({
        kind: "binary",
      });
  });

  test("text media types decode in full without a cap", () => {
    expect(
      decodeArtifactText(artifact("application/json", utf8("{}"))),
    ).toEqual({ kind: "text", text: "{}", truncated: false });
  });

  test("invalid UTF-8 inside the cap is not text", () => {
    const bytes = Uint8Array.of(0x61, 0xff, 0x62);
    expect(decodeArtifactText(artifact("text/plain", bytes))).toEqual({
      kind: "invalid_utf8",
    });
    expect(decodeArtifactText(artifact("text/plain", bytes), 3)).toEqual({
      kind: "invalid_utf8",
    });
  });

  test("a cut through a multi-byte character falls back to lossy decoding", () => {
    const bytes = utf8("ab\u00e9");
    expect(decodeArtifactText(artifact("text/plain", bytes), 3)).toEqual({
      kind: "text",
      text: "ab\ufffd",
      truncated: true,
    });
    expect(decodeArtifactText(artifact("text/plain", bytes), 2)).toEqual({
      kind: "text",
      text: "ab",
      truncated: true,
    });
  });
});

describe("artifactView", () => {
  test("keeps the panel's notes and 256 KiB cap", () => {
    expect(artifactView(artifact("image/png", utf8("x")), false)).toMatchObject(
      {
        text: null,
        truncated: false,
        note: "Binary artifact; content not displayed.",
      },
    );
    expect(
      artifactView(artifact("text/plain", Uint8Array.of(0xff)), false),
    ).toMatchObject({
      text: null,
      truncated: false,
      note: "Artifact is not valid UTF-8.",
    });
    const big = new Uint8Array(256 * 1024 + 2).fill(0x61);
    big.set(utf8("\u00e9"), 256 * 1024 - 1);
    const view = artifactView(artifact("text/plain", big), true);
    expect(view).toMatchObject({
      truncated: true,
      note: "Showing the first 256 KiB.",
      byte_length: big.byteLength,
      final_text: true,
    });
    expect(view.text?.endsWith("a\ufffd")).toBe(true);
    expect(view.text?.length).toBe(256 * 1024);
  });
});
