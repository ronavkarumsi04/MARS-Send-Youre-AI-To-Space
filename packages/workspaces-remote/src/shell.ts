import { createHash } from "node:crypto";
import { hasUnsupportedPathCharacters } from "@mars/contracts";
import {
  compareStrings,
  isIgnored,
  isSecret,
  type validateRelativePath,
} from "@mars/workspaces";
import type { ManifestFile, SkippedEntry, TreeManifest } from "./store";

/** POSIX single-quote; the only way user text reaches the remote shell. */
export function shellQuote(value: string): string {
  if (value.includes("\0"))
    throw new TypeError("Shell arguments cannot contain NUL bytes");
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Same digest the local provider's snapshotTree computes. */
export function treeDigest(
  files: readonly Pick<ManifestFile, "path" | "mode" | "sha256">[],
  directories: readonly string[],
): string {
  const lines = [
    ...files.map((file) => ({
      path: file.path,
      line: `F\0${file.path}\0${file.mode}\0${file.sha256}\n`,
    })),
    ...directories.map((path) => ({ path, line: `D\0${path}\n` })),
  ]
    .sort((a, b) => compareStrings(a.path, b.path))
    .map(({ line }) => line);
  return sha256Hex(lines.join(""));
}

export function buildManifest(
  files: ManifestFile[],
  directories: string[],
): TreeManifest {
  const sortedFiles = [...files].sort((a, b) => compareStrings(a.path, b.path));
  const sortedDirs = [...new Set(directories)].sort(compareStrings);
  return {
    files: sortedFiles,
    directories: sortedDirs,
    digest: treeDigest(sortedFiles, sortedDirs),
  };
}

const STATIC_PRUNE = [
  ".git",
  ".hg",
  ".svn",
  ".mars",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".tox",
  ".gradle",
  ".terraform",
];

const SEPARATOR = "\u001e";

/**
 * One remote command that lists a tree (type, mode, size, path; NUL
 * separated) and hashes its regular files. Ignored directories are pruned on
 * the server; everything else is classified client-side with the same rules
 * as the local snapshot, so the server never decides what counts.
 */
export function scanCommand(
  root: string,
  extraIgnores: readonly string[],
): string {
  const names = [...STATIC_PRUNE, ...extraIgnores];
  const prune = `\\( ${names.map((name) => `-iname ${shellQuote(name)}`).join(" -o ")} \\) -prune -o`;
  return [
    `cd -- ${shellQuote(root)}`,
    `find . -mindepth 1 ${prune} -printf '%y\\t%m\\t%s\\t%P\\0'`,
    `printf '${SEPARATOR}'`,
    `find . -mindepth 1 ${prune} -type f -exec sha256sum -- {} +`,
  ].join(" && ");
}

export interface ScanResult {
  manifest: TreeManifest;
  skipped: SkippedEntry[];
  /** Paths of every non-regular, non-directory entry (symlinks, devices). */
  blocked: Set<string>;
  totalBytes: number;
}

export class ScanParseError extends Error {}

export function parseScan(
  output: string,
  extraIgnores: readonly string[],
  validate: (path: string) => ReturnType<typeof validateRelativePath>,
): ScanResult {
  const split = output.indexOf(SEPARATOR);
  if (split < 0) throw new ScanParseError("scan output has no separator");
  const listing = output.slice(0, split);
  const hashes = new Map<string, string>();
  for (const line of output.slice(split + 1).split("\n")) {
    if (!line) continue;
    // GNU sha256sum escapes names with \ or newline and prefixes the line
    // with a backslash; such names are unsupported and skipped below.
    if (line.startsWith("\\")) continue;
    const match = /^([a-f0-9]{64}) [ *]\.\/(.+)$/.exec(line);
    if (!match?.[1] || !match[2]) throw new ScanParseError("bad hash line");
    hashes.set(match[2], match[1]);
  }
  const files: ManifestFile[] = [];
  const directories: string[] = [];
  const skipped: SkippedEntry[] = [];
  const blocked = new Set<string>();
  const skippedPrefixes: string[] = [];
  let totalBytes = 0;
  const entries = listing
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const [type, mode, size, ...rest] = record.split("\t");
      return { type, mode, size, path: rest.join("\t") };
    })
    .sort((a, b) => compareStrings(a.path, b.path));
  for (const entry of entries) {
    const { path } = entry;
    if (!entry.type || !entry.mode || !entry.size || !path)
      throw new ScanParseError("bad listing record");
    if (skippedPrefixes.some((prefix) => path.startsWith(prefix))) continue;
    if (isIgnored(path, extraIgnores)) {
      skippedPrefixes.push(`${path}/`);
      continue;
    }
    if (path.includes("\\") || hasUnsupportedPathCharacters(path)) {
      skipped.push({ path, reason: "unsupported-name" });
      skippedPrefixes.push(`${path}/`);
      blocked.add(path);
      continue;
    }
    if (entry.type === "l") {
      skipped.push({ path, reason: "symlink" });
      blocked.add(path);
      continue;
    }
    if (isSecret(path)) {
      skipped.push({ path, reason: "ignored-secret" });
      skippedPrefixes.push(`${path}/`);
      blocked.add(path);
      continue;
    }
    if (entry.type === "d") {
      directories.push(path);
      continue;
    }
    if (entry.type !== "f") {
      skipped.push({ path, reason: "special" });
      blocked.add(path);
      continue;
    }
    try {
      validate(path);
    } catch {
      skipped.push({ path, reason: "unsupported-name" });
      blocked.add(path);
      continue;
    }
    const sha = hashes.get(path);
    const size = Number(entry.size);
    if (!sha || !Number.isSafeInteger(size) || size < 0)
      throw new ScanParseError("file without hash");
    const executable = (Number.parseInt(entry.mode, 8) & 0o111) !== 0;
    totalBytes += size;
    files.push({ path, mode: executable ? 493 : 420, size, sha256: sha });
  }
  return {
    manifest: buildManifest(files, directories),
    skipped,
    blocked,
    totalBytes,
  };
}
