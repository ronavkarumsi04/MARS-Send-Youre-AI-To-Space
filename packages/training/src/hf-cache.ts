import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "./canonical";
import type { PinnedHfRef } from "./schemas";

/** Tokenizer files whose bytes are recorded in the tokenizer refs artifact, when present. */
export const TOKENIZER_FILES = [
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "added_tokens.json",
  "vocab.json",
  "merges.txt",
  "tokenizer.model",
] as const;
const TOKENIZER_CORE = ["tokenizer.json", "tokenizer.model", "vocab.json"];
const SHARD_FILE = /^[A-Za-z0-9._-]+\.safetensors$/;

/** `<cache>/models--org--name/snapshots/<revision>`, the huggingface_hub cache layout. */
export function snapshotDir(cacheDir: string, ref: PinnedHfRef): string {
  return path.join(
    cacheDir,
    `models--${ref.repo.replace("/", "--")}`,
    "snapshots",
    ref.revision,
  );
}

/**
 * Reads `file` from a pinned snapshot; null when absent or resolving outside
 * the cache root (huggingface_hub 2.x may keep blobs in a shared `<cache>/blobs`).
 */
export async function readSnapshotFile(
  cacheDir: string,
  ref: PinnedHfRef,
  file: string,
  maxBytes = 64 * 1024 * 1024,
): Promise<Uint8Array | null> {
  const target = path.join(snapshotDir(cacheDir, ref), file);
  try {
    const [resolved, root] = await Promise.all([
      realpath(target),
      realpath(cacheDir),
    ]);
    if (!resolved.startsWith(root + path.sep)) return null;
    const info = await lstat(resolved);
    if (!info.isFile() || info.size > maxBytes) return null;
    return new Uint8Array(await readFile(resolved));
  } catch {
    return null;
  }
}

async function exists(
  cacheDir: string,
  ref: PinnedHfRef,
  file: string,
): Promise<boolean> {
  try {
    const root = await realpath(cacheDir);
    const resolved = await realpath(
      path.join(snapshotDir(cacheDir, ref), file),
    );
    return (
      resolved.startsWith(root + path.sep) && (await lstat(resolved)).isFile()
    );
  } catch {
    return false;
  }
}

export async function baseModelCached(
  cacheDir: string,
  ref: PinnedHfRef,
): Promise<boolean> {
  if (!(await exists(cacheDir, ref, "config.json"))) return false;
  if (await exists(cacheDir, ref, "model.safetensors")) return true;
  const index = await readSnapshotFile(
    cacheDir,
    ref,
    "model.safetensors.index.json",
  );
  if (!index) return false;
  let shards: unknown[];
  try {
    shards = [
      ...new Set(
        Object.values(
          JSON.parse(new TextDecoder().decode(index)).weight_map ?? {},
        ),
      ),
    ];
  } catch {
    return false;
  }
  if (shards.length === 0) return false;
  for (const shard of shards) {
    if (typeof shard !== "string" || !SHARD_FILE.test(shard)) return false;
    if (!(await exists(cacheDir, ref, shard))) return false;
  }
  return true;
}

/** sha256 of every present tokenizer file, or null if no core tokenizer file is cached. */
export async function tokenizerFileDigests(
  cacheDir: string,
  ref: PinnedHfRef,
): Promise<Record<string, string> | null> {
  const digests: Record<string, string> = {};
  for (const file of TOKENIZER_FILES) {
    const bytes = await readSnapshotFile(cacheDir, ref, file);
    if (bytes) digests[file] = sha256(bytes);
  }
  return TOKENIZER_CORE.some((file) => file in digests) ? digests : null;
}
