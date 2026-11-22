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
import {
  makeDirectoryInside,
  pinVaultRoot,
  readNoteInside,
  removeFileInside,
} from "./paths";

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
  return {
    root,
    vault,
    parent,
    outside,
    swap,
    pinned: await pinVaultRoot(vault),
  };
}

test("race: reads reject a parent swapped after containment and before open", async () => {
  const { pinned, parent, swap } = await fixture();
  await expect(
    readNoteInside(pinned, join(parent, "note.md"), "note.md", swap),
  ).rejects.toMatchObject({ code: "path_escape" });
});

test("race: writes never modify an outside directory swapped before temp open", async () => {
  const { vault, pinned, parent, outside, swap } = await fixture();
  await expect(
    replaceDurably(
      join(parent, ".temp"),
      join(parent, "note.md"),
      "replacement",
      undefined,
      { root: pinned, beforeOpen: swap },
    ),
  ).rejects.toMatchObject({ code: "path_escape" });
  expect(await readFile(join(outside, "note.md"), "utf8")).toBe(
    "outside secret",
  );
  expect(await readdir(outside)).toEqual(["note.md"]);
  expect(await readFile(join(vault, "moved/note.md"), "utf8")).toBe("inside");
});

test("race: deletes reject a parent swapped before the file is opened", async () => {
  const { vault, pinned, parent, outside, swap } = await fixture();
  await expect(
    removeFileInside(pinned, join(parent, "note.md"), swap),
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
  const { vault, pinned } = await fixture();
  const path = join(vault, "root.md");
  await writeFile(path, "root note");
  await removeFileInside(pinned, path, undefined, { dev: -1, ino: -1 });
  expect(await readFile(path, "utf8")).toBe("root note");
  await removeFileInside(pinned, path);
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
});

test("race: directory creation rejects a swapped parent without creating outside children", async () => {
  const { pinned, parent, outside, swap } = await fixture();
  const next = join(parent, "new");
  await expect(
    makeDirectoryInside(pinned, next, async (path) => {
      if (path === next) await swap();
    }),
  ).rejects.toMatchObject({ code: "path_escape" });
  expect(await readdir(outside)).toEqual(["note.md"]);
});

for (const operation of ["read", "write", "delete", "mkdir", "lock"] as const) {
  test(`race: pinned ${operation} rejects a root rebound before the helper`, async () => {
    const { root, vault, pinned, outside } = await fixture();
    await writeFile(join(vault, "note.md"), "inside root note");
    await rename(vault, join(root, "moved-vault"));
    await symlink(outside, vault, "dir");
    const path = join(vault, "note.md");
    const action = {
      read: () => readNoteInside(pinned, path, "note.md"),
      write: () =>
        replaceDurably(join(vault, ".temp"), path, "replacement", undefined, {
          root: pinned,
        }),
      delete: () => removeFileInside(pinned, path),
      mkdir: () => makeDirectoryInside(pinned, join(vault, "new")),
      lock: () =>
        withVaultLock(pinned, async () => {
          throw new Error("must not run");
        }),
    }[operation];
    await expect(action()).rejects.toMatchObject({ code: "path_escape" });
    expect(await readFile(join(outside, "note.md"), "utf8")).toBe(
      "outside secret",
    );
    expect(await readdir(outside)).toEqual(["note.md"]);
    expect(await readFile(join(root, "moved-vault/note.md"), "utf8")).toBe(
      "inside root note",
    );
  });
}

for (const operation of ["read", "write", "delete"] as const) {
  test(`race: pinned ${operation} rejects root rebinding across an open`, async () => {
    const { root, vault, pinned, outside } = await fixture();
    await writeFile(join(vault, "note.md"), "inside root note");
    const swapRoot = async () => {
      await rename(vault, join(root, "moved-vault"));
      await symlink(outside, vault, "dir");
    };
    const path = join(vault, "note.md");
    const action = {
      read: () => readNoteInside(pinned, path, "note.md", swapRoot),
      write: () =>
        replaceDurably(join(vault, ".temp"), path, "replacement", undefined, {
          root: pinned,
          beforeOpen: swapRoot,
        }),
      delete: () => removeFileInside(pinned, path, swapRoot),
    }[operation];
    await expect(action()).rejects.toMatchObject({ code: "path_escape" });
    expect(await readFile(join(outside, "note.md"), "utf8")).toBe(
      "outside secret",
    );
    expect(await readdir(outside)).toEqual(["note.md"]);
    expect(await readFile(join(root, "moved-vault/note.md"), "utf8")).toBe(
      "inside root note",
    );
  });
}

test("race: root inode replacement is rejected even without a symlink", async () => {
  const { root, vault, pinned } = await fixture();
  await rename(vault, join(root, "moved-vault"));
  await mkdir(vault);
  await writeFile(join(vault, "note.md"), "replacement root note");
  await expect(
    readNoteInside(pinned, join(vault, "note.md"), "note.md"),
  ).rejects.toMatchObject({ code: "path_escape" });
});
