import { expect, test } from "bun:test";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { grep } from "@oh-my-pi/pi-natives";
import { MAX_SEARCH_BYTES, MAX_SEARCH_COLUMNS } from "../src";
import { context, makeFixture } from "./helpers";

test("workspace search is relative, honors scope, gitignore and glob, and distinguishes literal from regex", async () => {
  const f = await makeFixture({ git: false });
  try {
    const root = await f.provider.workspacePath(context, f.workspace);
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "src", "one.ts"),
      "before\nneedle.a\nneedleXa\nafter\n",
    );
    await writeFile(join(root, "src", "two.js"), "needle.a\n");
    await writeFile(join(root, ".gitignore"), "ignored.txt\n");
    await writeFile(join(root, "ignored.txt"), "needle.a\n");
    const search = (request: Parameters<typeof f.provider.search>[2]) =>
      f.provider.search(context, f.workspace, request);
    const regex = await search({
      pattern: "needle.a",
      path: "src",
      glob: "*.ts",
      context: 1,
    });
    expect(
      regex.matches.map((match) => [match.path, match.lineNumber]),
    ).toEqual([
      ["src/one.ts", 2],
      ["src/one.ts", 3],
    ]);
    expect(regex.matches[0]?.contextBefore).toEqual([
      { lineNumber: 1, line: "before" },
    ]);
    expect(regex.matches[1]?.contextAfter).toEqual([
      { lineNumber: 4, line: "after" },
    ]);
    expect(
      (
        await search({
          pattern: "NEEDLE.a",
          literal: true,
          ignore_case: true,
          path: "src/one.ts",
        })
      ).matches.map((match) => match.lineNumber),
    ).toEqual([2]);
    expect(
      (await search({ pattern: "needle", glob: "ignored.txt" })).matches,
    ).toEqual([]);
    expect(
      (await search({ pattern: "needle", path: "ignored.txt" })).matches,
    ).toEqual([]);
    expect((await search({ pattern: "nothing matches" })).matches).toEqual([]);
    expect(await readFile(join(f.sourceRoot, "tracked.txt"), "utf8")).toContain(
      "baseline tracked",
    );
  } finally {
    await f.close();
  }
});

test("workspace search rejects escaping scopes and never returns secrets, ignored names or symlinks", async () => {
  const f = await makeFixture({ git: false, extraIgnores: ["generated*"] });
  try {
    const root = await f.provider.workspacePath(context, f.workspace);
    const paths = [
      "visible.txt",
      ".env",
      ".ENV",
      "node_modules/pkg/a.txt",
      ".git/config",
      "generated-code/a.txt",
      "nested/.ssh/key",
    ];
    for (const path of paths) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), "canary\n");
    }
    await writeFile(join(f.sourceRoot, "outside.txt"), "outside-canary\n");
    await symlink(f.sourceRoot, join(root, "outside-dir"));
    await symlink(
      join(f.sourceRoot, "outside.txt"),
      join(root, "outside-file"),
    );
    await symlink(join(root, "visible.txt"), join(root, "inside-file"));
    const native = await grep({
      pattern: "outside-canary",
      path: root,
      gitignore: true,
    });
    expect(native.matches).toEqual([]);
    const result = await f.provider.search(context, f.workspace, {
      pattern: "canary",
      context: 5,
    });
    expect(result.matches.map((match) => match.path)).toEqual(["visible.txt"]);
    expect(JSON.stringify(result)).not.toContain(f.base);
    for (const path of [
      "../source/outside.txt",
      "/etc/passwd",
      "outside-dir/outside.txt",
      "outside-file",
      "inside-file",
      ".env",
      "node_modules/pkg/a.txt",
      "generated-code/a.txt",
    ]) {
      await expect(
        f.provider.search(context, f.workspace, { pattern: "canary", path }),
      ).rejects.toThrow();
    }
    await expect(
      f.provider.search(
        { ...context, scope: { owner_id: "other", project_id: "other" } },
        f.workspace,
        { pattern: "canary" },
      ),
    ).rejects.toThrow();
  } finally {
    await f.close();
  }
});

test("workspace search enforces independent match, context, column and UTF-8 byte caps", async () => {
  const f = await makeFixture({ git: false });
  try {
    const root = await f.provider.workspacePath(context, f.workspace);
    await writeFile(
      join(root, "many.txt"),
      Array.from({ length: 300 }, () => "needle ".repeat(200)).join("\n"),
    );
    const result = await f.provider.search(context, f.workspace, {
      pattern: "needle",
      max_matches: 10000,
      context: 10000,
    });
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.length).toBeLessThanOrEqual(200);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
      MAX_SEARCH_BYTES,
    );
    expect(result.truncated).toBe(true);
    expect(result.limitReached).toBe(true);
    for (const match of result.matches) {
      expect(Array.from(match.line).length).toBeLessThanOrEqual(
        MAX_SEARCH_COLUMNS,
      );
      expect(match.contextBefore?.length ?? 0).toBeLessThanOrEqual(5);
      expect(match.contextAfter?.length ?? 0).toBeLessThanOrEqual(5);
      for (const line of [
        ...(match.contextBefore ?? []),
        ...(match.contextAfter ?? []),
      ])
        expect(Array.from(line.line).length).toBeLessThanOrEqual(
          MAX_SEARCH_COLUMNS,
        );
    }
    expect(
      (
        await f.provider.search(context, f.workspace, {
          pattern: "needle",
          max_matches: 2,
        })
      ).matches,
    ).toHaveLength(2);
    await writeFile(
      join(root, "many.txt"),
      Array(300).fill("needle").join("\n"),
    );
    const countBound = await f.provider.search(context, f.workspace, {
      pattern: "needle",
      path: "many.txt",
      max_matches: 10000,
    });
    expect(countBound.matches).toHaveLength(200);
    expect(countBound.limitReached).toBe(true);
    await writeFile(
      join(root, "context.txt"),
      [...Array(8).fill("before"), "needle", ...Array(8).fill("after")].join(
        "\n",
      ),
    );
    const contextBound = await f.provider.search(context, f.workspace, {
      pattern: "needle",
      path: "context.txt",
      context: 10000,
    });
    expect(contextBound.matches[0]?.contextBefore).toHaveLength(5);
    expect(contextBound.matches[0]?.contextAfter).toHaveLength(5);
    await writeFile(join(root, "wide.txt"), `needle${"😀".repeat(2000)}`);
    const wide = await f.provider.search(context, f.workspace, {
      pattern: "needle",
      path: "wide.txt",
    });
    expect(wide.truncated).toBe(true);
    expect(Array.from(wide.matches[0]?.line ?? "").length).toBeLessThanOrEqual(
      MAX_SEARCH_COLUMNS,
    );
    await expect(
      f.provider.search(context, f.workspace, {
        pattern: "needle",
        path: "missing.txt",
      }),
    ).rejects.toThrow("Search scope is unavailable");
    await expect(
      f.provider.search(context, f.workspace, {
        pattern: "needle",
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();
    await expect(
      f.provider.search(context, f.workspace, {
        pattern: "needle",
        max_matches: 0,
      }),
    ).rejects.toThrow();
  } finally {
    await f.close();
  }
});
