import { expect, test } from "bun:test";
import { sha256 } from "@mars/contracts/canonical";
import { createWorkspaceDiff } from "../src/diff";
import type { TreeFile } from "../src/tree";

const file = (
  path: string,
  bytes: number[],
  mode: 420 | 493 = 420,
): TreeFile => {
  const data = Uint8Array.from(bytes);
  return { path, mode, size: data.byteLength, sha256: sha256(data), data };
};

test("binary patches record both content hashes so different bytes never render the same patch", () => {
  const base = [file("image.png", [0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3])];
  const versionA = [file("image.png", [0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9])];
  const versionB = [file("image.png", [0x89, 0x50, 0x4e, 0x47, 0, 8, 8, 8])];
  const a = createWorkspaceDiff(base, versionA).files[0];
  const b = createWorkspaceDiff(base, versionB).files[0];
  expect(a?.status).toBe("modified");
  expect(a?.patch).toContain("Binary files a/image.png and b/image.png differ");
  expect(a?.patch).toContain(
    `index ${base[0]?.sha256}..${versionA[0]?.sha256}\n`,
  );
  expect(a?.patch).not.toBe(b?.patch);
  const added = createWorkspaceDiff([], versionA).files[0];
  const addedB = createWorkspaceDiff([], versionB).files[0];
  expect(added?.patch).toContain(
    `index ${"0".repeat(64)}..${versionA[0]?.sha256}\n`,
  );
  expect(added?.patch).not.toBe(addedB?.patch);
  const deleted = createWorkspaceDiff(base, []).files[0];
  expect(deleted?.patch).toContain(
    `index ${base[0]?.sha256}..${"0".repeat(64)}\n`,
  );
  expect(createWorkspaceDiff(base, base).files).toEqual([]);
});

const BOM = [0xef, 0xbb, 0xbf];
const text = (value: string) => [...new TextEncoder().encode(value)];

async function gitApplyRoundTrip(
  before: number[],
  after: number[],
): Promise<Uint8Array> {
  const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "mars-diff-"));
  try {
    await writeFile(join(dir, "a.ts"), Uint8Array.from(before));
    const patch = createWorkspaceDiff(
      [file("a.ts", before)],
      [file("a.ts", after)],
    )
      .files.map((entry) => entry.patch)
      .join("");
    await writeFile(join(dir, "change.patch"), patch);
    for (const args of [["--check"], []]) {
      const proc = Bun.spawnSync(["git", "apply", ...args, "change.patch"], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.stderr.toString()).toBe("");
      expect(proc.exitCode).toBe(0);
    }
    return new Uint8Array(await readFile(join(dir, "a.ts")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a BOM-only edit renders a hunk that git applies to the exact bytes", async () => {
  const plain = text("export const x = 1;\n");
  const withBom = [...BOM, ...plain];
  const added = createWorkspaceDiff(
    [file("a.ts", plain)],
    [file("a.ts", withBom)],
  ).files[0];
  expect(added?.patch).toContain("@@ -1,1 +1,1 @@\n");
  expect(added?.patch).toContain("+\uFEFFexport const x = 1;\n");
  expect([...(await gitApplyRoundTrip(plain, withBom))]).toEqual(withBom);
  expect([...(await gitApplyRoundTrip(withBom, plain))]).toEqual(plain);
});

test("CRLF and missing final newline survive a git apply round trip byte for byte", async () => {
  const before = [...BOM, ...text("a\r\nb\r\nc")];
  const after = [...BOM, ...text("a\r\nB\r\nc\n")];
  expect([...(await gitApplyRoundTrip(before, after))]).toEqual(after);
});
