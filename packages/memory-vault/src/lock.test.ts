import { afterEach, expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VAULT_LOCK_FILE, withVaultLock } from "./lock";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mars-vault-lock-"));
  roots.push(root);
  return root;
}
const worker = join(import.meta.dir, "../test/lock-worker.ts");

test("locking: separate processes never overlap their critical sections", async () => {
  const root = await fixture();
  const spawn = () =>
    Bun.spawn([process.execPath, worker, root], {
      stdout: "pipe",
      stderr: "pipe",
    });
  const children = [spawn(), spawn(), spawn()];
  expect(await Promise.all(children.map((child) => child.exited))).toEqual([
    0, 0, 0,
  ]);
  expect(await readFile(join(root, "events"), "utf8")).toBe(
    "start\nend\nstart\nend\nstart\nend\n",
  );
});

test("locking: a crashed owner is recovered without stealing an aged live lock", async () => {
  const root = await fixture();
  const child = Bun.spawn([process.execPath, worker, root, "crash"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await child.exited).toBe(0);
  await writeFile(
    join(root, `${VAULT_LOCK_FILE}.reap`),
    JSON.stringify({ pid: child.pid }),
  );
  await withVaultLock(root, async () => {
    const path = join(root, VAULT_LOCK_FILE);
    const old = new Date(0);
    await utimes(path, old, old);
    const waiter = Bun.spawn([process.execPath, worker, root], {
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      await Bun.sleep(100);
      expect(await readFile(join(root, "events"), "utf8")).toBe("start\n");
    } finally {
      waiter.kill();
      await waiter.exited;
    }
  });
});

test("locking: stale malformed locks recover, errors release locks, and aliases serialize", async () => {
  const root = await fixture();
  const path = join(root, VAULT_LOCK_FILE);
  await writeFile(path, "{");
  await utimes(path, new Date(0), new Date(0));
  await expect(
    withVaultLock(root, async () => {
      throw new Error("action failed");
    }),
  ).rejects.toThrow("action failed");
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  const alias = `${root}-alias`;
  await symlink(root, alias);
  roots.push(alias);
  let active = 0;
  let peak = 0;
  const action = async () => {
    active++;
    peak = Math.max(peak, active);
    await Bun.sleep(20);
    active--;
  };
  await Promise.all([
    withVaultLock(root, action),
    withVaultLock(alias, action),
  ]);
  expect(peak).toBe(1);
});
