import { constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readlink,
  realpath,
  rm,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const KEEP = /[A-Za-z0-9._-]/;
const MAX_SEGMENT = 128;
/** Whole graph-note file name budget (before `.md`), under the 255-byte limit. */
const MAX_FILE_NAME = 200;
export const VAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;

/** Truncates an encoded name with a digest of the original so it stays unique. */
function bound(original: string, encoded: string, limit: number): string {
  if (encoded.length <= limit) return encoded;
  const digest = new Bun.CryptoHasher("sha256")
    .update(original)
    .digest("hex")
    .slice(0, 16);
  return `${encoded.slice(0, limit - 17)}-${digest}`;
}

function percentEncode(char: string): string {
  return Array.from(new TextEncoder().encode(char))
    .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
    .join("");
}

/**
 * Maps an id, name or path component to one safe file-name segment. Safe
 * inputs pass through unchanged; anything else is percent-encoded per code
 * point (including `%` itself, so decoding is unambiguous), a leading `.` or
 * `-` is encoded so no segment is hidden or looks like an option, and
 * overlong results are truncated with a digest suffix.
 */
export function encodeSegment(value: string): string {
  if (value.length === 0) throw new VaultPathError("empty_segment");
  if (SAFE.test(value) && value !== "." && value !== "..") return value;
  let out = "";
  let index = 0;
  for (const char of value) {
    out +=
      KEEP.test(char) && !(index === 0 && (char === "." || char === "-"))
        ? char
        : percentEncode(char);
    index += 1;
  }
  return bound(value, out, MAX_SEGMENT);
}

/**
 * Workspace-relative source path → one segment (`/` and `\` become `__`).
 * Runs of two or more underscores inside a component are percent-encoded so
 * `a/b` and `a__b` never collide.
 */
export function encodeSourcePath(path: string): string {
  const joined = path
    .split(/[\\/]+/)
    .filter((part) => part.length > 0)
    .map((part) =>
      bound(
        part,
        encodeSegment(part).replace(/_{2,}/g, (run) =>
          "%5F".repeat(run.length),
        ),
        MAX_SEGMENT,
      ),
    )
    .join("__");
  return bound(path, joined, MAX_FILE_NAME);
}

export class VaultPathError extends Error {
  constructor(
    readonly code:
      | "empty_segment"
      | "path_escape"
      | "private_root"
      | "path_collision"
      | "file_too_large",
    detail?: string,
  ) {
    super(
      detail ? `memory-vault: ${code}: ${detail}` : `memory-vault: ${code}`,
    );
    this.name = "VaultPathError";
  }
}

export function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path === "" ||
    (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
  );
}

/**
 * Validates a vault-relative note path (forward slashes, no empty, `.` or
 * `..` segments, no absolute or drive prefix) and returns its absolute
 * location, which must stay inside `vaultDir`.
 */
export function resolveInside(vaultDir: string, notePath: string): string {
  if (
    notePath.length === 0 ||
    notePath.includes("\\") ||
    notePath.includes("\0") ||
    notePath.startsWith("/") ||
    /^[A-Za-z]:/.test(notePath) ||
    notePath
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  )
    throw new VaultPathError("path_escape", notePath);
  const absolute = resolve(vaultDir, notePath);
  if (!contains(vaultDir, absolute) || absolute === vaultDir)
    throw new VaultPathError("path_escape", notePath);
  return absolute;
}

/**
 * Reads a regular file without following a symlink in its final component,
 * even one swapped in after an earlier check: the file is opened with
 * O_NOFOLLOW and read through the handle. Throws VaultPathError for a link
 * (or anything that is not a regular file) and ENOENT for a missing file.
 */
export async function readFileNoFollow(
  absolute: string,
  label: string,
  vaultDir?: string,
  beforeOpen?: () => Promise<void>,
): Promise<string> {
  await beforeOpen?.();
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      absolute,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK")
      throw new VaultPathError("path_escape", `${label} is a symlink`);
    throw error;
  }
  try {
    if (vaultDir) await verifyOpenedInside(vaultDir, absolute, handle);
    const stat = await handle.stat();
    if (!stat.isFile())
      throw new VaultPathError("path_escape", `${label} is not a regular file`);
    if (stat.size > VAULT_MAX_FILE_BYTES)
      throw new VaultPathError(
        "file_too_large",
        `${label} exceeds ${VAULT_MAX_FILE_BYTES} bytes`,
      );
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buffer = Buffer.alloc(
        Math.min(64 * 1024, VAULT_MAX_FILE_BYTES - total + 1),
      );
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > VAULT_MAX_FILE_BYTES)
        throw new VaultPathError(
          "file_too_large",
          `${label} exceeds ${VAULT_MAX_FILE_BYTES} bytes`,
        );
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function readNoteInside(
  vaultDir: string,
  absolute: string,
  label: string,
  beforeOpen?: () => Promise<void>,
): Promise<string> {
  const [realVault, realParent] = await Promise.all([
    realpathExisting(vaultDir),
    realpathExisting(dirname(absolute)),
  ]);
  if (!contains(realVault, realParent))
    throw new VaultPathError(
      "path_escape",
      `${label} resolves outside the vault`,
    );
  return readFileNoFollow(absolute, label, realVault, beforeOpen);
}

export function descriptorPath(handle: FileHandle, fallback: string): string {
  return process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : fallback;
}

export async function makeDirectoryInside(
  vaultDir: string,
  absolute: string,
  beforeCreate?: (path: string) => Promise<void>,
): Promise<void> {
  const realVault = await realpathExisting(vaultDir);
  if (!contains(resolve(vaultDir), resolve(absolute)))
    throw new VaultPathError("path_escape");
  const flags =
    constants.O_RDONLY |
    (constants.O_DIRECTORY ?? 0) |
    (constants.O_NOFOLLOW ?? 0);
  let current = resolve(vaultDir);
  let directory = await open(current, flags);
  try {
    await verifyOpenedInside(realVault, current, directory);
    for (const part of relative(current, absolute).split(sep).filter(Boolean)) {
      const next = join(current, part);
      await beforeCreate?.(next);
      await verifyOpenedInside(realVault, current, directory);
      const anchored = join(descriptorPath(directory, current), part);
      try {
        await mkdir(anchored, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const child = await open(anchored, flags);
      try {
        await verifyOpenedInside(realVault, next, child);
      } catch (error) {
        await child.close();
        throw error;
      }
      const previous = directory;
      directory = child;
      current = next;
      await previous.close();
    }
  } finally {
    await directory.close();
  }
}

export async function verifyOpenedInside(
  realVault: string,
  absolute: string,
  handle: FileHandle,
): Promise<void> {
  const reject = () =>
    new VaultPathError(
      "path_escape",
      "opened path escapes or changed inside the vault",
    );
  try {
    if (process.platform === "linux") {
      const opened = await readlink(`/proc/self/fd/${handle.fd}`);
      if (!isAbsolute(opened) || !contains(realVault, opened)) throw reject();
    }
    const owned = await handle.stat();
    const realParent = await realpath(
      owned.isDirectory() ? absolute : dirname(absolute),
    );
    if (!contains(realVault, realParent)) throw reject();
    const current = await lstat(
      owned.isDirectory() ? absolute : join(realParent, basename(absolute)),
    );
    if (current.isSymbolicLink()) throw reject();
    if (owned.dev !== current.dev || owned.ino !== current.ino)
      throw Object.assign(reject(), { cause: { code: "ESTALE" } });
  } catch (error) {
    if (error instanceof VaultPathError) throw error;
    if (
      ["ENOENT", "ENOTDIR", "ELOOP"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw Object.assign(reject(), { cause: error });
    throw error;
  }
}

export async function removeFileInside(
  vaultDir: string,
  absolute: string,
  beforeOpen?: () => Promise<void>,
  expected?: { dev: number; ino: number },
): Promise<void> {
  const realVault = await realpathExisting(vaultDir);
  const parentPath = await realpath(dirname(absolute));
  const parent = await open(
    parentPath,
    constants.O_RDONLY |
      (constants.O_DIRECTORY ?? 0) |
      (constants.O_NOFOLLOW ?? 0),
  );
  try {
    await verifyOpenedInside(realVault, parentPath, parent);
    await beforeOpen?.();
    const path = join(
      descriptorPath(parent, dirname(absolute)),
      basename(absolute),
    );
    const file = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      await verifyOpenedInside(realVault, absolute, file);
      const owned = await file.stat();
      if (
        expected &&
        (owned.dev !== expected.dev || owned.ino !== expected.ino)
      )
        return;
      await verifyOpenedInside(realVault, parentPath, parent);
      // A same-name replacement can still race the final identity check and unlink.
      // Without /proc fd paths, a parent swap can also race this final unlink.
      await rm(path);
    } finally {
      await file.close();
    }
  } finally {
    await parent.close();
  }
}

/**
 * Resolves symlinks in `path` even when its tail does not exist yet: the
 * nearest existing ancestor is resolved and the missing tail re-appended.
 */
export async function realpathExisting(path: string): Promise<string> {
  const absolute = resolve(path);
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      await lstat(current);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    missing.unshift(relative(parent, current));
    current = parent;
  }
  return resolve(await realpath(current), ...missing);
}

/**
 * Refuses a vault directory that overlaps any host-private root. Both sides
 * are compared after symlink resolution so a vault that is a link into the
 * state directory (or a private root reached through a link) is caught.
 */
export async function assertVaultDirectory(
  vaultDir: string,
  privateRoots: readonly string[],
): Promise<void> {
  const vault = await realpathExisting(vaultDir);
  for (const root of privateRoots) {
    const resolved = resolve(root);
    const real = await realpathExisting(root);
    for (const candidate of [resolved, real])
      if (
        contains(candidate, vaultDir) ||
        contains(vaultDir, candidate) ||
        contains(candidate, vault) ||
        contains(vault, candidate)
      )
        throw new VaultPathError("private_root");
  }
}
