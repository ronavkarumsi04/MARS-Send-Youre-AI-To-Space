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

  test("follows dangling symlinks so targets outside the root cannot masquerade as inside", () => {
    withTempDir((dir) => {
      const ws = join(dir, "ws");
      const outside = join(dir, "outside");
      mkdirSync(ws);
      mkdirSync(outside);
      symlinkSync(join(outside, "missing.txt"), join(ws, "dangling.txt"));
      symlinkSync("../outside/missing-dir", join(ws, "dangling-dir"));
      const direct = resolveForSafety(join(ws, "dangling.txt"));
      expect(direct).toBe(join(outside, "missing.txt"));
      expect(isInsideOrEqual(ws, direct)).toBe(false);
      const nested = resolveForSafety(join(ws, "dangling-dir", "child.txt"));
      expect(nested).toBe(join(outside, "missing-dir", "child.txt"));
      expect(isInsideOrEqual(ws, nested)).toBe(false);
    });
  });

  test("rejects symlink loops with ELOOP instead of returning a path inside the root", () => {
    withTempDir((dir) => {
      symlinkSync(join(dir, "b"), join(dir, "a"));
      symlinkSync(join(dir, "a"), join(dir, "b"));
      expect(() => resolveForSafety(join(dir, "a"))).toThrow(
        /Too many levels of symbolic links/,
      );
    });
  });
});
