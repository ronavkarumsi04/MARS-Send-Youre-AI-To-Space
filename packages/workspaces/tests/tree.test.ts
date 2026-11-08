import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE_LIMITS, snapshotTree } from "../src/tree";

const roots: string[] = [];
afterEach(async () => {
  for (const dir of roots.splice(0))
    await rm(dir, { recursive: true, force: true });
});

test("tree snapshots keep their pinned file and tree digests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mars-tree-"));
  roots.push(dir);
  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "src", "a.txt"), "hello\n");
  await writeFile(join(dir, "README.md"), "# x\n");
  for (const includeData of [true, false]) {
    const tree = await snapshotTree(dir, {
      limits: DEFAULT_WORKSPACE_LIMITS,
      includeData,
    });
    expect(tree.files.map(({ path, sha256 }) => [path, sha256])).toEqual([
      [
        "README.md",
        "253b610bd786f2543252c8d4b45bb40eb375882587f825cb9ce1fd1241f66f1e",
      ],
      [
        "src/a.txt",
        "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
      ],
    ]);
    expect(tree.digest).toBe(
      "fddb4dd5cf182a28cf0e303ec5552a7f71879d413b28edcb4583973c7d50cfbd",
    );
  }
});
