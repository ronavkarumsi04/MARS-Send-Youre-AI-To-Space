import { describe, expect, test } from "bun:test";
import { parsePatch } from "../src/patch";
import { applyPatchText } from "./fixtures";

const before = "a\nb\nc\nd\ne\nf\ng\nh\n";
const twoHunks =
  "--- a/f\n+++ b/f\n@@ -1,2 +1,3 @@\n a\n+a2\n b\n@@ -7,2 +8,1 @@\n-g\n h\n";
const after = "a\na2\nb\nc\nd\ne\nf\nh\n";

describe("forward and reverse application", () => {
  test("multi-hunk patches round-trip exactly", () => {
    expect(applyPatchText(before, twoHunks)).toBe(after);
    expect(applyPatchText(after, twoHunks, true)).toBe(before);
  });

  test("no fuzz: shifted or edited baselines do not apply", () => {
    expect(applyPatchText(`x\n${before}`, twoHunks)).toBeNull();
    expect(applyPatchText(before.replace("g", "G"), twoHunks)).toBeNull();
    expect(applyPatchText(after, twoHunks)).toBeNull();
  });

  test("target-side headers must agree with the computed offsets", () => {
    const badNew = "@@ -1,2 +1,3 @@\n a\n+a2\n b\n@@ -7,2 +9,1 @@\n-g\n h\n";
    expect(parsePatch(badNew).ok).toBe(true);
    expect(applyPatchText(before, badNew)).toBeNull();
  });

  test("pure insertion hunks", () => {
    expect(applyPatchText("a\nb\n", "@@ -1,0 +2,1 @@\n+x\n")).toBe("a\nx\nb\n");
  });

  test("end-of-file newline markers are honoured", () => {
    const patch =
      "@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n";
    expect(applyPatchText("a", patch)).toBe("b");
    expect(applyPatchText("a\n", patch)).toBeNull();
    const addNewline = "@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+a\n";
    expect(applyPatchText("a", addNewline)).toBe("a\n");
    expect(applyPatchText("a\n", addNewline, true)).toBe("a");
  });

  test("CRLF content is preserved byte for byte", () => {
    const patch = "@@ -1,2 +1,2 @@\n one\r\n-two\r\n+TWO\r\n";
    expect(applyPatchText("one\r\ntwo\r\n", patch)).toBe("one\r\nTWO\r\n");
  });
});

describe("added and deleted content", () => {
  test("only pure additions/removals against an empty file qualify", () => {
    expect(applyPatchText("", "@@ -0,0 +1,2 @@\n+x\n+y\n")).toBe("x\ny\n");
    expect(
      applyPatchText("", "@@ -0,0 +1 @@\n+x\n\\ No newline at end of file\n"),
    ).toBe("x");
    expect(applyPatchText("", "@@ -1,1 +1,2 @@\n x\n+y\n")).toBeNull();
    expect(applyPatchText("", "@@ -1,2 +0,0 @@\n-x\n-y\n", true)).toBe(
      "x\ny\n",
    );
    expect(applyPatchText("", "@@ -1,2 +1,1 @@\n-x\n y\n", true)).toBeNull();
  });
});

describe("parsePatch rejection", () => {
  test.each([
    ["binary files", "Binary files a/x and b/x differ\n"],
    ["git binary", "GIT binary patch\nliteral 0\n"],
    ["NUL byte", "@@ -1 +1 @@\n-a\u0000\n+b\n"],
    ["no hunks", "--- a/x\n+++ b/x\n"],
    ["short hunk", "@@ -1,2 +1,2 @@\n-a\n+b\n"],
    ["long hunk", "@@ -1 +1 @@\n-a\n+b\n+c\n"],
    ["unknown line", "@@ -1 +1 @@\n?a\n+b\n"],
    ["bad header", "@@ -x +1 @@\n+b\n"],
    ["empty hunk", "@@ -0,0 +0,0 @@\n"],
    [
      "marker before more lines",
      "@@ -1,2 +1,2 @@\n-a\n\\ No newline at end of file\n-b\n+c\n+d\n",
    ],
    ["second file", "@@ -1 +1 @@\n-a\n+b\ndiff --git a/y b/y\n"],
  ])("%s", (_name, patch) => {
    expect(parsePatch(patch).ok).toBe(false);
  });
});
