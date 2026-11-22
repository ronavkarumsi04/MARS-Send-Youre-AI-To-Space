import { constants } from "node:fs";
import { mkdir, open, lstat as stat } from "node:fs/promises";
import { join } from "node:path";
import { VaultError } from "./errors";
import {
  descriptorPath,
  readFileNoFollow,
  realpathExisting,
  removeFileInside,
  VaultPathError,
  verifyOpenedInside,
} from "./paths";

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

async function stale(path: string, realVault: string): Promise<boolean> {
  try {
    const info = await stat(path);
    const age = Date.now() - info.mtimeMs;
    let record: unknown;
    try {
      record = JSON.parse(
        await readFileNoFollow(path, VAULT_LOCK_FILE, realVault),
      );
    } catch (error) {
      if (error instanceof SyntaxError) return age > VAULT_LOCK_LIMITS.stale_ms;
      if (
        error instanceof VaultPathError &&
        ["ENOENT", "ESTALE"].includes(
          (error.cause as NodeJS.ErrnoException | undefined)?.code ?? "",
        )
      )
        return false;
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
  realVault: string,
): Promise<void> {
  try {
    const current = await stat(path);
    if (owned.ino === current.ino && owned.dev === current.dev)
      await removeFileInside(realVault, path, undefined, owned);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function reap(path: string, realVault: string): Promise<void> {
  const guard = `${path}.reap`;
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(guard, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      try {
        const owned = await stat(guard);
        if (await stale(guard, realVault))
          await removeOwned(guard, owned, realVault);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return;
    }
    throw error;
  }
  const owned = await file.stat();
  try {
    await verifyOpenedInside(realVault, guard, file);
    await file.writeFile(JSON.stringify({ pid: process.pid }));
    try {
      const locked = await stat(path);
      if (await stale(path, realVault))
        await removeOwned(path, locked, realVault);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } finally {
    try {
      await removeOwned(guard, owned, realVault);
    } finally {
      await file.close();
    }
  }
}

async function acquire(
  vaultDir: string,
  deadline: number,
  realVault: string,
): Promise<() => Promise<void>> {
  const path = join(vaultDir, VAULT_LOCK_FILE);
  for (;;) {
    if (Date.now() >= deadline) throw new VaultError("vault_locked");
    let file: Awaited<ReturnType<typeof open>>;
    try {
      file = await open(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await reap(path, realVault);
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
      await verifyOpenedInside(realVault, path, file);
      await file.writeFile(JSON.stringify({ pid: process.pid }));
      const current = await stat(path);
      if (owned.ino !== current.ino || owned.dev !== current.dev) {
        await file.close();
        continue;
      }
      return async () => {
        try {
          await removeOwned(path, owned, realVault);
        } finally {
          await file.close();
        }
      };
    } catch (error) {
      try {
        await removeOwned(path, owned, realVault);
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
  options: { timeout_ms?: number; beforeOpen?: () => Promise<void> } = {},
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
    const directory = await open(
      key,
      constants.O_RDONLY |
        (constants.O_DIRECTORY ?? 0) |
        (constants.O_NOFOLLOW ?? 0),
    );
    try {
      await verifyOpenedInside(key, key, directory);
      await options.beforeOpen?.();
      await verifyOpenedInside(key, key, directory);
      const release = await acquire(
        descriptorPath(directory, key),
        deadline,
        key,
      );
      try {
        return await action();
      } finally {
        await release();
      }
    } finally {
      await directory.close();
    }
  } finally {
    clearTimeout(timer);
    releaseLocal();
    void queued.then(() => {
      if (pending.get(key) === queued) pending.delete(key);
    });
  }
}
