/**
 * Filesystem helpers shared by skill discovery and the slash-command loader:
 * the admission gates every untrusted repository file passes before it is
 * loaded into agent context. Symlinks are reported, never followed.
 */
import { lstat, readdir, readFile } from "node:fs/promises";

export type EntryKind = "file" | "directory" | "symlink" | "other";

/** `lstat`-based kind of `path`; null when it does not exist. */
export async function entryKind(path: string): Promise<EntryKind | null> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) return "symlink";
    if (stats.isDirectory()) return "directory";
    if (stats.isFile()) return "file";
    return "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Sorted directory entries; empty when `path` is missing or not a directory. */
export async function sortedEntries(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
}

export type BoundedUtf8 =
  | { text: string; bytes: number }
  | { reason: "oversize" | "encoding" };

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Reads a regular file of at most `maxBytes` (by `lstat` size) as strict
 * UTF-8. Failures carry the skip reason both loaders report.
 */
export async function readBoundedUtf8(
  absolute: string,
  maxBytes: number,
): Promise<BoundedUtf8> {
  const stats = await lstat(absolute);
  if (stats.size > maxBytes) return { reason: "oversize" };
  try {
    return {
      text: decoder.decode(await readFile(absolute)),
      bytes: stats.size,
    };
  } catch {
    return { reason: "encoding" };
  }
}
