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

  test("a character split by the cut is dropped, not replaced", () => {
    const bytes = utf8("ab\u00e9");
    expect(decodeArtifactText(artifact("text/plain", bytes), 3)).toEqual({
      kind: "text",
      text: "ab",
      truncated: true,
    });
    expect(decodeArtifactText(artifact("text/plain", bytes), 2)).toEqual({
      kind: "text",
      text: "ab",
      truncated: true,
    });
    const emoji = utf8("a\u{1F600}b");
    for (const cut of [2, 3, 4])
      expect(decodeArtifactText(artifact("text/plain", emoji), cut)).toEqual({
        kind: "text",
        text: "a",
        truncated: true,
      });
  });

  test("malformed bytes before the cut are not text even when truncated", () => {
    for (const bytes of [
      Uint8Array.of(0x61, 0xff, 0x62, 0x63, 0x64),
      Uint8Array.of(0x61, 0xc3, 0x28, 0x62, 0x63),
      Uint8Array.of(0x61, 0xed, 0xa0, 0x80, 0x62),
      Uint8Array.of(0x61, 0x62, 0xff, 0x63),
    ])
      expect(decodeArtifactText(artifact("text/plain", bytes), 3)).toEqual({
        kind: "invalid_utf8",
      });
  });

  test("an uncut artifact ending in a partial character is not text", () => {
    expect(
      decodeArtifactText(
        artifact("text/plain", utf8("ab\u00e9").subarray(0, 3)),
      ),
    ).toEqual({ kind: "invalid_utf8" });
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
    expect(view.text).toBe("a".repeat(256 * 1024 - 1));
    const corrupt = new Uint8Array(256 * 1024 + 1).fill(0x61);
    corrupt[10] = 0xff;
    expect(artifactView(artifact("text/plain", corrupt), false)).toMatchObject({
      text: null,
      truncated: false,
      note: "Artifact is not valid UTF-8.",
    });
  });
});
