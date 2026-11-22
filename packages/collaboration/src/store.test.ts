import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollaborationStore } from "./store";

test("collaboration store rejects database symlinks without changing the target", async () => {
  const root = await mkdtemp(join(tmpdir(), "collaboration-symlink-"));
  const target = join(root, "private.sqlite");
  const db = new Database(target);
  db.exec("CREATE TABLE private_data (value TEXT)");
  db.close();
  const original = await readFile(target);
  const rootDir = join(root, "collaboration");
  await mkdir(rootDir);
  await symlink(target, join(rootDir, "collaboration.sqlite"));
  let store: CollaborationStore | undefined;
  try {
    await expect(
      (async () => {
        store = await CollaborationStore.open({
          rootDir,
          hostPrivateRoots: [],
        });
      })(),
    ).rejects.toThrow("Collaboration state file must be a regular file");
    expect(await readFile(target)).toEqual(original);
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});
