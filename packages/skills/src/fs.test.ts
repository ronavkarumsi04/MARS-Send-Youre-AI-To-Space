import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entryKind, readBoundedUtf8, sortedEntries } from "./fs";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mars-skills-fs-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("entryKind / sortedEntries", () => {
  it("reports kinds without following symlinks and lists entries sorted", async () => {
    await mkdir(join(root, "dir"));
    await writeFile(join(root, "b.md"), "b");
    await symlink(join(root, "b.md"), join(root, "a.md"));
    expect(await entryKind(join(root, "dir"))).toBe("directory");
    expect(await entryKind(join(root, "b.md"))).toBe("file");
    expect(await entryKind(join(root, "a.md"))).toBe("symlink");
    expect(await entryKind(join(root, "missing"))).toBeNull();
    expect(await sortedEntries(root)).toEqual(["a.md", "b.md", "dir"]);
    expect(await sortedEntries(join(root, "missing"))).toEqual([]);
    expect(await sortedEntries(join(root, "b.md"))).toEqual([]);
  });
});

describe("readBoundedUtf8", () => {
  it("admits files up to the byte cap and keeps a BOM verbatim", async () => {
    const path = join(root, "ok.md");
    await writeFile(path, "\uFEFFhé");
    expect(await readBoundedUtf8(path, 6)).toEqual({
      text: "\uFEFFhé",
      bytes: 6,
    });
    expect(await readBoundedUtf8(path, 5)).toEqual({ reason: "oversize" });
  });

  it("rejects invalid UTF-8", async () => {
    const path = join(root, "bin.md");
    await writeFile(path, Buffer.from([0x68, 0xff, 0xfe]));
    expect(await readBoundedUtf8(path, 1024)).toEqual({ reason: "encoding" });
  });
});
