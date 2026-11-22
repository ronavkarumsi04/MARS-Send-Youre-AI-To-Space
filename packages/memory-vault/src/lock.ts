import { mkdir, open, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { VaultError } from "./errors";
import { readFileNoFollow, realpathExisting } from "./paths";

export const VAULT_LOCK_FILE = ".mars-vault.lock";
export const VAULT_LOCK_LIMITS = {
  timeout_ms: 30_000,
  retry_ms: 20,
  stale_ms: 60_000,
} as const;
const pending = new Map<string, Promise<void>>();

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function stale(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    const age = Date.now() - info.mtimeMs;
    let record: unknown;
    try {
      record = JSON.parse(await readFileNoFollow(path, VAULT_LOCK_FILE));
    } catch (error) {
      if (error instanceof SyntaxError) return age > VAULT_LOCK_LIMITS.stale_ms;
      throw error;
    }
    const pid = (record as { pid?: unknown } | null)?.pid;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0)
      return age > VAULT_LOCK_LIMITS.stale_ms;
    return age >= 0 && !alive(pid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function removeOwned(
  path: string,
  owned: { ino: number; dev: number },
): Promise<void> {
  try {
    const current = await stat(path);
    if (owned.ino === current.ino && owned.dev === current.dev) await rm(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function reap(path: string): Promise<void> {
  const guard = `${path}.reap`;
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(guard, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      try {
        const owned = await stat(guard);
        if (await stale(guard)) await removeOwned(guard, owned);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return;
    }
    throw error;
  }
  const owned = await file.stat();
  try {
    await file.writeFile(JSON.stringify({ pid: process.pid }));
    try {
      const locked = await stat(path);
      if (await stale(path)) await removeOwned(path, locked);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } finally {
    try {
      await removeOwned(guard, owned);
    } finally {
      await file.close();
    }
  }
}

async function acquire(
  vaultDir: string,
  deadline: number,
): Promise<() => Promise<void>> {
  const path = join(vaultDir, VAULT_LOCK_FILE);
  for (;;) {
    let file: Awaited<ReturnType<typeof open>>;
    try {
      file = await open(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await reap(path);
      if (Date.now() >= deadline)
        throw new VaultError(
          "vault_locked",
          "timed out waiting for another vault operation",
        );
      await Bun.sleep(VAULT_LOCK_LIMITS.retry_ms);
      continue;
    }
    const owned = await file.stat();
    try {
      await file.writeFile(JSON.stringify({ pid: process.pid }));
      const current = await stat(path);
      if (owned.ino !== current.ino || owned.dev !== current.dev) {
        await file.close();
        continue;
      }
      return async () => {
        try {
          await removeOwned(path, owned);
        } finally {
          await file.close();
        }
      };
    } catch (error) {
      try {
        await removeOwned(path, owned);
      } finally {
        await file.close();
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
}

export async function withVaultLock<T>(
  vaultDir: string,
  action: () => Promise<T>,
  options: { timeout_ms?: number } = {},
): Promise<T> {
  const deadline =
    Date.now() + (options.timeout_ms ?? VAULT_LOCK_LIMITS.timeout_ms);
  const key = await realpathExisting(vaultDir);
  const previous = pending.get(key) ?? Promise.resolve();
  let releaseLocal = () => {};
  const current = new Promise<void>((resolve) => {
    releaseLocal = resolve;
  });
  const queued = previous.then(() => current);
  pending.set(key, queued);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      previous,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new VaultError(
                "vault_locked",
                "timed out waiting for another vault operation",
              ),
            ),
          Math.max(0, deadline - Date.now()),
        );
      }),
    ]);
    clearTimeout(timer);
    if (Date.now() >= deadline) throw new VaultError("vault_locked");
    await mkdir(key, { recursive: true, mode: 0o700 });
    const release = await acquire(key, deadline);
    try {
      return await action();
    } finally {
      await release();
    }
  } finally {
    clearTimeout(timer);
    releaseLocal();
    void queued.then(() => {
      if (pending.get(key) === queued) pending.delete(key);
    });
  }
}
