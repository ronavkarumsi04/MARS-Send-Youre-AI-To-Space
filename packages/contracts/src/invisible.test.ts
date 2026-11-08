import { describe, expect, test } from "bun:test";
import {
  hasInvisibleCodePoint,
  INVISIBLE_CODE_POINT_RANGES,
  isInvisibleCodePoint,
} from "./invisible";

describe("invisible code points", () => {
  test("every listed range boundary is invisible", () => {
    for (const [start, end] of INVISIBLE_CODE_POINT_RANGES) {
      expect(isInvisibleCodePoint(start)).toBe(true);
      expect(isInvisibleCodePoint(end)).toBe(true);
    }
  });

  test("controls are invisible except tab and newline", () => {
    for (let c = 0; c < 0x20; c++)
      expect(isInvisibleCodePoint(c)).toBe(c !== 0x09 && c !== 0x0a);
    expect(isInvisibleCodePoint(0x7f)).toBe(true);
    expect(isInvisibleCodePoint(0x80)).toBe(true);
    expect(isInvisibleCodePoint(0x9f)).toBe(true);
  });

  test("visible text passes", () => {
    expect(hasInvisibleCodePoint("plain text\twith tab\nand newline")).toBe(
      false,
    );
    expect(hasInvisibleCodePoint("日本語 ünïcödé 👍")).toBe(false);
  });

  test("smuggled code points are found, including astral ones", () => {
    expect(hasInvisibleCodePoint("a\u200bb")).toBe(true);
    expect(hasInvisibleCodePoint("a\rb")).toBe(true);
    expect(hasInvisibleCodePoint("👍\ufe0f")).toBe(true);
    expect(hasInvisibleCodePoint("x\u{e0041}")).toBe(true);
  });
});
