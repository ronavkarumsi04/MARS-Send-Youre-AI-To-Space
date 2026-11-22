import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replaceDurably } from "./durable";
import { withVaultLock } from "./lock";
import { makeDirectoryInside, readNoteInside, removeFileInside } from "./paths";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vault-parent-race-"));
  roots.push(root);
  const vault = join(root, "vault");
  const parent = join(vault, "notes");
  const outside = join(root, "outside");
  await mkdir(parent, { recursive: true });
  await mkdir(outside);
  await writeFile(join(parent, "note.md"), "inside");
  await writeFile(join(outside, "note.md"), "outside secret");
  const swap = async () => {
    await rename(parent, join(vault, "moved"));
    await symlink(outside, parent, "dir");
  };
  return { root, vault, parent, outside, swap };
}

test("race: reads reject a parent swapped after containment and before open", async () => {
  const { vault, parent, swap } = await fixture();
  await expect(
    readNoteInside(vault, join(parent, "note.md"), "note.md", swap),
  ).rejects.toMatchObject({ code: "path_escape" });
});

test("race: writes never modify an outside directory swapped before temp open", async () => {
  const { vault, parent, outside, swap } = await fixture();
  await expect(
    replaceDurably(
      join(parent, ".temp"),
      join(parent, "note.md"),
      "replacement",
      undefined,
      { vaultDir: vault, beforeOpen: swap },
    ),
  ).rejects.toMatchObject({ code: "path_escape" });
  expect(await readFile(join(outside, "note.md"), "utf8")).toBe(
    "outside secret",
  );
  expect(await readdir(outside)).toEqual(["note.md"]);
  expect(await readFile(join(vault, "moved/note.md"), "utf8")).toBe("inside");
});

test("race: deletes reject a parent swapped before the file is opened", async () => {
  const { vault, parent, outside, swap } = await fixture();
  await expect(
    removeFileInside(vault, join(parent, "note.md"), swap),
  ).rejects.toMatchObject({ code: "path_escape" });
  expect(await readFile(join(outside, "note.md"), "utf8")).toBe(
    "outside secret",
  );
  expect(await readFile(join(vault, "moved/note.md"), "utf8")).toBe("inside");
});

test("race: lock creation rejects a root swapped before exclusive open", async () => {
  const { root, vault, outside } = await fixture();
  let ran = false;
  await expect(
    withVaultLock(
      vault,
      async () => {
        ran = true;
      },
      {
        beforeOpen: async () => {
          await rename(vault, join(root, "moved-vault"));
          await symlink(outside, vault, "dir");
        },
      },
    ),
  ).rejects.toMatchObject({ code: "path_escape" });
  expect(ran).toBe(false);
  expect(await readdir(outside)).toEqual(["note.md"]);
});

test("race: verified deletion accepts root files and ignores a different owner", async () => {
  const { vault } = await fixture();
  const path = join(vault, "root.md");
  await writeFile(path, "root note");
  await removeFileInside(vault, path, undefined, { dev: -1, ino: -1 });
  expect(await readFile(path, "utf8")).toBe("root note");
  await removeFileInside(vault, path);
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
});

test("race: directory creation rejects a swapped parent without creating outside children", async () => {
  const { vault, parent, outside, swap } = await fixture();
  const next = join(parent, "new");
  await expect(
    makeDirectoryInside(vault, next, async (path) => {
      if (path === next) await swap();
    }),
  ).rejects.toMatchObject({ code: "path_escape" });
  expect(await readdir(outside)).toEqual(["note.md"]);
});
