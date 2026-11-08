import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { z } from "zod";
import { ScopeSchema } from "./index";

/**
 * Strict reader for the private `connection.json` that `mars serve` writes,
 * shared by every local client (CLI, Shell, VS Code). It decides which URL
 * may receive the bearer token, so all clients must use this one rule.
 */

/** Upper bound for a `mars serve` connection.json; real files are ~200 bytes. */
export const MAX_CONNECTION_FILE_BYTES = 16 * 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

const ConnectionFileSchema = z
  .object({
    schema_version: z.literal(1),
    url: z.string().max(256),
    token: z.string(),
    scope: z
      .object({
        owner_id: ScopeSchema.shape.owner_id,
        project_id: ScopeSchema.shape.project_id,
      })
      .strict(),
  })
  .strict();

export interface LocalConnection {
  /** Normalized `http://<loopback>[:port]` origin, no trailing slash. */
  url: string;
  token: string;
  scope: { owner_id: string; project_id: string };
}

export type ConnectionResult =
  | { ok: true; connection: LocalConnection }
  | { ok: false; reason: string };

export type FileRead =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: string };

/** Loopback rule for a WHATWG `URL.hostname` (IPv6 stays bracketed: `[::1]`). */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "[::1]") return true;
  const parts = host.split(".");
  if (parts.length !== 4 || parts[0] !== "127") return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function fail(reason: string): ConnectionResult {
  return { ok: false, reason };
}

/**
 * Strictly parses a `mars serve` connection file. Error reasons are fixed
 * strings: they never echo file content, so the token cannot leak through them.
 */
export function parseConnectionFile(bytes: Uint8Array): ConnectionResult {
  if (bytes.byteLength > MAX_CONNECTION_FILE_BYTES)
    return fail("Connection file is larger than 16 KiB.");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("Connection file is not valid UTF-8.");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail("Connection file is not valid JSON.");
  }
  const parsed = ConnectionFileSchema.safeParse(raw);
  if (!parsed.success)
    return fail(
      "Connection file must contain exactly schema_version 1, url, token and scope {owner_id, project_id}.",
    );
  const file = parsed.data;
  if (!TOKEN_PATTERN.test(file.token))
    return fail("Connection file token has an invalid format.");
  let url: URL;
  try {
    url = new URL(file.url);
  } catch {
    return fail("Connection file url is not a valid URL.");
  }
  if (url.protocol !== "http:")
    return fail("Connection file url must use http on a loopback address.");
  if (!isLoopbackHost(url.hostname))
    return fail("Connection file url must be a loopback address.");
  if (url.username || url.password || url.search || url.hash)
    return fail(
      "Connection file url must not contain credentials, a query or a fragment.",
    );
  if (url.pathname !== "/" || file.url.includes("?") || file.url.includes("#"))
    return fail("Connection file url must be a root URL with no path.");
  return {
    ok: true,
    connection: { url: url.origin, token: file.token, scope: file.scope },
  };
}

/**
 * Reads at most `MAX_CONNECTION_FILE_BYTES` from a regular file without
 * following symlinks. On POSIX the file must not be readable or writable by
 * group/others, matching the mode 0600 `mars serve` uses.
 */
export async function readConnectionFile(
  path: string,
  platform: NodeJS.Platform = process.platform,
): Promise<FileRead> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return { ok: false, reason: "Could not open the connection file." };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile())
      return { ok: false, reason: "Connection file is not a regular file." };
    if (platform !== "win32" && (info.mode & 0o077) !== 0)
      return {
        ok: false,
        reason:
          "Connection file is accessible to other users. Restrict it with chmod 600 and try again.",
      };
    if (info.size > MAX_CONNECTION_FILE_BYTES)
      return { ok: false, reason: "Connection file is larger than 16 KiB." };
    const buffer = new Uint8Array(MAX_CONNECTION_FILE_BYTES + 1);
    let total = 0;
    while (total < buffer.byteLength) {
      const { bytesRead } = await handle.read(
        buffer,
        total,
        buffer.byteLength - total,
        null,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_CONNECTION_FILE_BYTES)
      return { ok: false, reason: "Connection file is larger than 16 KiB." };
    return { ok: true, bytes: buffer.slice(0, total) };
  } catch {
    return { ok: false, reason: "Could not read the connection file." };
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Opens and parses a connection file in one step. */
export async function loadConnectionFile(
  path: string,
  platform: NodeJS.Platform = process.platform,
): Promise<ConnectionResult> {
  const file = await readConnectionFile(path, platform);
  return file.ok ? parseConnectionFile(file.bytes) : file;
}
