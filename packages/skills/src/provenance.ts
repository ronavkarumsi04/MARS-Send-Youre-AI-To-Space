import { createHash } from "node:crypto";
import { join } from "node:path";
import { type CheckoutFS, inside } from "./checkout-fs";

export interface SkillProvenance {
  source?: string;
  sourceType?: string;
  computedHash?: string;
  lockedHash?: string;
  status: "match" | "modified" | "unpinned" | "unverified";
}

export interface SkillHashFile {
  path: string;
  content: Buffer;
}

/** skills-lock v2: UTF-8 byte order, NUL framing, CRLF normalization for non-NUL files. */
export function hashSkillFiles(files: readonly SkillHashFile[]): string {
  const hash = createHash("sha256");
  const sorted = files
    .map(({ path, content }) => ({
      path: Buffer.from(path.replaceAll("\\", "/")),
      content: content.includes(0)
        ? content
        : Buffer.from(
            content.toString("latin1").replaceAll("\r\n", "\n"),
            "latin1",
          ),
    }))
    .sort((a, b) => Buffer.compare(a.path, b.path));
  for (const { path, content } of sorted) {
    hash
      .update(path)
      .update("\0")
      .update(String(content.length))
      .update("\0")
      .update(content);
  }
  return hash.digest("hex");
}

const MAX_HASH_BYTES = 16 * 1024 * 1024;
const MAX_HASH_ENTRIES = 4096;
const EXCLUDED_DIRS = new Set([".git", "__pycache__", "__pypackages__"]);

export async function computeSkillHash(
  fs: CheckoutFS,
  folder: string,
): Promise<string> {
  const entry = await fs.entry(folder);
  if (!entry) throw new Error("unsafe skill folder");
  const root = entry.path;
  await entry.handle.close();
  const files: SkillHashFile[] = [];
  let bytes = 0;
  let count = 0;
  async function walk(
    path: string,
    prefix: string,
    ancestors: Set<string>,
    depth: number,
  ): Promise<void> {
    if (depth > 64) throw new Error("hash depth limit");
    const dir = await fs.directory(path);
    if (!dir) throw new Error("unreadable skill folder");
    for (const name of dir) {
      if (++count > MAX_HASH_ENTRIES) throw new Error("hash entry limit");
      if (name === "metadata.json") continue;
      const full = join(path, name);
      const item = await fs.entry(full);
      if (!item) continue; // Broken, looping and escaping links are excluded by v2.
      const canonical = item.path;
      const stat = await item.handle.stat();
      await item.handle.close();
      if (!inside(root, canonical)) continue;
      if (stat.isDirectory()) {
        if (EXCLUDED_DIRS.has(name) || ancestors.has(canonical)) continue;
        await walk(
          canonical,
          `${prefix}${name}/`,
          new Set(ancestors).add(canonical),
          depth + 1,
        );
      } else if (stat.isFile()) {
        const read = await fs.read(canonical, MAX_HASH_BYTES - bytes);
        if ("reason" in read || !inside(root, read.path))
          throw new Error("hash byte limit or unreadable file");
        bytes += read.data.length;
        files.push({ path: prefix + name, content: read.data });
      }
    }
  }
  await walk(root, "", new Set([root]), 0);
  return hashSkillFiles(files);
}

type LockEntry = { source: string; sourceType: string; computedHash: string };
export async function readSkillsLock(
  fs: CheckoutFS,
): Promise<Map<string, LockEntry>> {
  if (!(await fs.directory(""))?.includes("skills-lock.json")) return new Map();
  const read = await fs.read("skills-lock.json", 1024 * 1024);
  if ("reason" in read) {
    throw new Error("unreadable or oversized skills-lock.json");
  }
  const lock: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(read.data),
  );
  if (
    !lock ||
    typeof lock !== "object" ||
    !("version" in lock) ||
    lock.version !== 2 ||
    !("skills" in lock) ||
    !lock.skills ||
    typeof lock.skills !== "object" ||
    Array.isArray(lock.skills)
  )
    throw new Error("expected skills-lock.json version 2 with a skills map");
  const entries = new Map<string, LockEntry>();
  for (const [name, value] of Object.entries(lock.skills)) {
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.source !== "string" ||
      !value.source.length ||
      value.source.length > 256 ||
      /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value.source) ||
      typeof value.sourceType !== "string" ||
      !/^[a-z0-9_-]{1,64}$/.test(value.sourceType) ||
      typeof value.computedHash !== "string" ||
      !/^(?:[a-f0-9]{64})?$/.test(value.computedHash)
    )
      throw new Error(`invalid skills-lock.json entry`);
    entries.set(name, value);
  }
  return entries;
}

export async function skillProvenance(
  fs: CheckoutFS,
  folder: string,
  name: string,
  entries: Awaited<ReturnType<typeof readSkillsLock>>,
): Promise<SkillProvenance> {
  const locked = entries.get(name);
  const base = locked
    ? {
        source: locked.source,
        sourceType: locked.sourceType,
        lockedHash: locked.computedHash,
      }
    : {};
  try {
    const computedHash = await computeSkillHash(fs, folder);
    return {
      ...base,
      computedHash,
      status: !locked?.computedHash
        ? "unpinned"
        : locked.computedHash === computedHash
          ? "match"
          : "modified",
    };
  } catch {
    return { ...base, status: "unverified" };
  }
}
