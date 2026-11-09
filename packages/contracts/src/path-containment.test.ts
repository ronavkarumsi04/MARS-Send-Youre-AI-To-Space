import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  isInsideOrEqual,
  isStrictlyInside,
  resolveForSafety,
} from "./path-containment";

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

describe("resolveForSafety", () => {
  function withTempDir(run: (dir: string) => void): void {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "mars-resolve-")));
    try {
      run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("expands symlinks of existing paths", () => {
    withTempDir((dir) => {
      const target = join(dir, "target");
      mkdirSync(target);
      symlinkSync(target, join(dir, "link"));
      expect(resolveForSafety(join(dir, "link"))).toBe(target);
    });
  });

  test("resolves the nearest existing ancestor of a missing path", () => {
    withTempDir((dir) => {
      const target = join(dir, "target");
      mkdirSync(target);
      symlinkSync(target, join(dir, "link"));
      expect(resolveForSafety(join(dir, "link", "missing", "leaf"))).toBe(
        join(target, "missing", "leaf"),
      );
    });
  });

  test("makes relative paths absolute", () => {
    expect(resolveForSafety("relative-missing-path")).toBe(
      resolveForSafety(resolve("relative-missing-path")),
    );
  });
});
