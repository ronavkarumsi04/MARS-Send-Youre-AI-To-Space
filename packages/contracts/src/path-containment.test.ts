import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { isInsideOrEqual, isStrictlyInside } from "./path-containment";

const root = resolve("/srv/root");

describe("path containment", () => {
  test("root itself is inside only for the inclusive variant", () => {
    expect(isInsideOrEqual(root, root)).toBe(true);
    expect(isStrictlyInside(root, root)).toBe(false);
  });

  test("descendants are inside for both variants", () => {
    for (const candidate of [join(root, "a"), join(root, "a", "b")]) {
      expect(isInsideOrEqual(root, candidate)).toBe(true);
      expect(isStrictlyInside(root, candidate)).toBe(true);
    }
  });

  test("parents, siblings and unrelated paths are outside", () => {
    for (const candidate of [
      resolve(root, ".."),
      resolve(root, "..", "sibling"),
      resolve("/elsewhere"),
    ]) {
      expect(isInsideOrEqual(root, candidate)).toBe(false);
      expect(isStrictlyInside(root, candidate)).toBe(false);
    }
  });

  test("names that merely start with '..' are inside", () => {
    const candidate = join(root, "..foo");
    expect(isInsideOrEqual(root, candidate)).toBe(true);
    expect(isStrictlyInside(root, candidate)).toBe(true);
  });
});
