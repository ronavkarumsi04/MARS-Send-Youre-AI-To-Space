import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { EvolutionError, fail } from "./errors";
import { digestOf, sha256 } from "./util";

export type FileMode = "100644" | "100755";

export interface TreeEntry {
  path: string;
  mode: FileMode;
  sha256: string;
  size: number;
}

export interface TreeSnapshot {
  entries: TreeEntry[];
  blobs: Map<string, Uint8Array>;
  tree_sha256: string;
}

export interface SnapshotLimits {
  maxFiles: number;
  maxBytes: number;
  /** Directory names skipped while walking (never part of a harness tree). */
  skipDirs: readonly string[];
}

export const DEFAULT_SNAPSHOT_LIMITS: SnapshotLimits = {
  maxFiles: 20_000,
  maxBytes: 64 * 1024 * 1024,
  skipDirs: [".git", "node_modules"],
};

/** Digest of a harness tree: sorted (path, mode, blob digest) triples. */
export function treeDigest(entries: readonly TreeEntry[]): string {
  return digestOf(
    [...entries]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((entry) => [entry.path, entry.mode, entry.sha256]),
  );
}

/**
 * Reads a directory into a content-addressed snapshot. Symlinks and special
 * files are refused, so a materialised candidate can never point outside its
 * own workspace.
 */
export async function snapshotDirectory(
  root: string,
  limits: Partial<SnapshotLimits> = {},
): Promise<TreeSnapshot> {
  const effective = { ...DEFAULT_SNAPSHOT_LIMITS, ...limits };
  const entries: TreeEntry[] = [];
  const blobs = new Map<string, Uint8Array>();
  let total = 0;
  async function walk(relative: string): Promise<void> {
    const absolute = relative ? join(root, relative) : root;
    const names = (await readdir(absolute)).sort();
    for (const name of names) {
      const path = relative ? `${relative}/${name}` : name;
      const info = await lstat(join(root, path));
      if (info.isSymbolicLink())
        fail("unsafe_path", `symlink in harness tree: ${path}`);
      if (info.isDirectory()) {
        if (effective.skipDirs.includes(name)) continue;
        await walk(path);
        continue;
      }
      if (!info.isFile())
        fail("unsafe_path", `special file in harness tree: ${path}`);
      validateTreePath(path);
      const data = new Uint8Array(await readFile(join(root, path)));
      total += data.byteLength;
      if (entries.length + 1 > effective.maxFiles || total > effective.maxBytes)
        fail("invalid_input", "harness tree exceeds snapshot limits");
      const digest = sha256(data);
      blobs.set(digest, data);
      entries.push({
        path,
        mode: info.mode & 0o111 ? "100755" : "100644",
        sha256: digest,
        size: data.byteLength,
      });
    }
  }
  await walk("");
  return { entries, blobs, tree_sha256: treeDigest(entries) };
}

/** Writes a snapshot into a fresh directory (which must not exist yet). */
export async function materialize(
  dir: string,
  entries: readonly TreeEntry[],
  readBlob: (sha256: string) => Uint8Array,
): Promise<void> {
  await mkdir(dirname(dir), { recursive: true, mode: 0o700 });
  await mkdir(dir, { mode: 0o700 });
  for (const entry of entries) {
    validateTreePath(entry.path);
    const data = readBlob(entry.sha256);
    if (sha256(data) !== entry.sha256)
      fail("corrupt_record", `blob digest mismatch for ${entry.path}`);
    const target = join(dir, entry.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, data, { flag: "wx", mode: 0o600 });
    await chmod(target, entry.mode === "100755" ? 0o700 : 0o600);
  }
}

function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function validateTreePath(path: string): void {
  if (
    path.length === 0 ||
    path.length > 1024 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    hasControlCharacter(path)
  )
    fail("unsafe_patch", `unsafe path: ${JSON.stringify(path)}`);
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..")
      fail("unsafe_patch", `unsafe path: ${JSON.stringify(path)}`);
    if (segment.toLowerCase() === ".git")
      fail("unsafe_patch", `path inside .git: ${JSON.stringify(path)}`);
  }
}

export interface PatchFile {
  path: string;
  kind: "add" | "modify" | "delete";
  mode: FileMode | null;
}

const ALLOWED_MODES = new Set(["100644", "100755"]);
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripPrefix(raw: string, prefix: "a/" | "b/"): string | null {
  const value = raw.replace(/\t.*$/, "");
  if (value === "/dev/null") return null;
  if (value.startsWith('"')) fail("unsafe_patch", "quoted paths are refused");
  if (!value.startsWith(prefix))
    fail(
      "unsafe_patch",
      `expected ${prefix} prefix in ${JSON.stringify(value)}`,
    );
  return value.slice(2);
}

/**
 * Strict parser for `git diff` output. Hunk line counts are honoured, so a
 * `diff --git` line can only start a file section, never hide inside one.
 * Renames, copies, binary patches, symlinks and gitlinks are refused.
 */
export function parsePatch(text: string): PatchFile[] {
  if (text.includes("\u0000")) fail("unsafe_patch", "NUL byte in patch");
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const files: PatchFile[] = [];
  let index = 0;
  while (index < lines.length && !lines[index]?.startsWith("diff --git "))
    index += 1;
  if (
    index !== 0 &&
    lines.slice(0, index).some((line) => line.startsWith("--- "))
  )
    fail("unsafe_patch", "only git-format patches are accepted");
  while (index < lines.length) {
    const header = lines[index] as string;
    if (!header.startsWith("diff --git "))
      fail("unsafe_patch", `unexpected line ${index + 1}`);
    const rest = header.slice("diff --git ".length);
    const half = (rest.length - 5) / 2;
    const headerPath = Number.isInteger(half) ? rest.slice(2, 2 + half) : "";
    if (!headerPath || rest !== `a/${headerPath} b/${headerPath}`)
      fail("unsafe_patch", "diff header must name the same path on both sides");
    index += 1;
    let kind: PatchFile["kind"] = "modify";
    let mode: FileMode | null = null;
    let oldPath: string | null | undefined;
    let newPath: string | null | undefined;
    let sawHunk = false;
    while (index < lines.length && !lines[index]?.startsWith("diff --git ")) {
      const line = lines[index] as string;
      const extended =
        /^(new file mode|deleted file mode|old mode|new mode) (\d+)$/.exec(
          line,
        );
      if (extended) {
        const value = extended[2] as string;
        if (!ALLOWED_MODES.has(value))
          fail("unsafe_patch", `file mode ${value} is refused (${headerPath})`);
        if (extended[1] === "new file mode") kind = "add";
        if (extended[1] === "deleted file mode") kind = "delete";
        if (extended[1] !== "old mode" && extended[1] !== "deleted file mode")
          mode = value as FileMode;
        index += 1;
        continue;
      }
      if (
        /^(rename|copy) (from|to) /.test(line) ||
        /^similarity index /.test(line)
      )
        fail("unsafe_patch", `renames and copies are refused (${headerPath})`);
      if (
        line.startsWith("GIT binary patch") ||
        line.startsWith("Binary files ")
      )
        fail("unsafe_patch", `binary patches are refused (${headerPath})`);
      if (line.startsWith("index ")) {
        index += 1;
        continue;
      }
      if (line.startsWith("--- ")) {
        oldPath = stripPrefix(line.slice(4), "a/");
        index += 1;
        continue;
      }
      if (line.startsWith("+++ ")) {
        newPath = stripPrefix(line.slice(4), "b/");
        index += 1;
        continue;
      }
      const hunk = HUNK.exec(line);
      if (hunk) {
        if (oldPath === undefined || newPath === undefined)
          fail("unsafe_patch", `hunk before file header (${headerPath})`);
        sawHunk = true;
        let oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
        let newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
        index += 1;
        while (oldLeft > 0 || newLeft > 0) {
          const body = lines[index];
          if (body === undefined) fail("unsafe_patch", "truncated hunk");
          const marker = body[0];
          if (marker === " " || body === "") {
            oldLeft -= 1;
            newLeft -= 1;
          } else if (marker === "-") oldLeft -= 1;
          else if (marker === "+") newLeft -= 1;
          else if (marker !== "\\")
            fail("unsafe_patch", `bad hunk line ${index + 1}`);
          if (oldLeft < 0 || newLeft < 0)
            fail("unsafe_patch", "hunk counts overrun");
          index += 1;
        }
        while (lines[index]?.startsWith("\\")) index += 1;
        continue;
      }
      fail("unsafe_patch", `unexpected line ${index + 1} in ${headerPath}`);
    }
    for (const named of [oldPath, newPath])
      if (named !== undefined && named !== null && named !== headerPath)
        fail("unsafe_patch", "file header paths disagree with the diff header");
    if (kind === "add" && oldPath !== undefined && oldPath !== null)
      fail("unsafe_patch", "new file must come from /dev/null");
    if (kind === "delete" && newPath !== undefined && newPath !== null)
      fail("unsafe_patch", "deleted file must go to /dev/null");
    if (!sawHunk && mode === null && kind !== "delete" && !(kind === "add"))
      fail("unsafe_patch", `empty file section (${headerPath})`);
    validateTreePath(headerPath);
    if (files.some((file) => file.path === headerPath))
      fail("unsafe_patch", `path appears twice: ${headerPath}`);
    files.push({ path: headerPath, kind, mode });
  }
  if (files.length === 0) fail("unsafe_patch", "patch changes no files");
  return files;
}

export function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => new Bun.Glob(pattern).match(path));
}

/** Refuses a change set touching protected paths or anything outside the mutable allowlist. */
export function enforcePathPolicy(
  paths: readonly string[],
  policy: {
    mutable_paths: readonly string[];
    protected_paths: readonly string[];
  },
): void {
  for (const path of paths) {
    validateTreePath(path);
    if (matchesAny(path, policy.protected_paths))
      fail("protected_path", `candidate may not change protected path ${path}`);
    if (!matchesAny(path, policy.mutable_paths))
      fail(
        "protected_path",
        `path ${path} is outside the mutable harness paths`,
      );
  }
}

/** Paths whose presence, mode or content differs between two trees. */
export function changedPaths(
  before: readonly TreeEntry[],
  after: readonly TreeEntry[],
): string[] {
  const left = new Map(before.map((entry) => [entry.path, entry]));
  const right = new Map(after.map((entry) => [entry.path, entry]));
  const changed = new Set<string>();
  for (const [path, entry] of left) {
    const other = right.get(path);
    if (!other || other.sha256 !== entry.sha256 || other.mode !== entry.mode)
      changed.add(path);
  }
  for (const path of right.keys()) if (!left.has(path)) changed.add(path);
  return [...changed].sort();
}

export interface ApplyOptions {
  gitPath: string;
  timeoutMs?: number;
}

/**
 * Applies a validated patch with `git apply` (repository discovery disabled
 * above the tree, no global/system config), checking first so a failed hunk
 * leaves the tree untouched.
 */
export async function applyPatch(
  dir: string,
  patch: string,
  options: ApplyOptions,
): Promise<void> {
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: dir,
    LANG: "C",
    GIT_CEILING_DIRECTORIES: dirname(dir),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  for (const args of [["apply", "--check"], ["apply"]]) {
    const child = Bun.spawn(
      [options.gitPath, ...args, "--whitespace=nowarn", "-"],
      {
        cwd: dir,
        env,
        stdin: new TextEncoder().encode(patch),
        stdout: "pipe",
        stderr: "pipe",
        timeout: options.timeoutMs ?? 30_000,
      },
    );
    const [stderr, exit] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exit !== 0)
      throw new EvolutionError(
        "patch_failed",
        stderr.trim().slice(0, 500) || `git apply exited ${exit}`,
      );
  }
}
