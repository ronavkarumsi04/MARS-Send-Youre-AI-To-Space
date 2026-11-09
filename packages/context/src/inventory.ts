import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fsPromises from "node:fs/promises";
import {
  type FileHandle,
  lstat,
  open,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ParseCacheEntry } from "./cache";
import {
  ContextCancelledError,
  ContextConfinementUnavailableError,
  ContextIoError,
} from "./errors";
import { extractPython, PYTHON_EXTRACTOR_VERSION } from "./extract-python";
import { extractTypeScript, TS_EXTRACTOR_VERSION } from "./extract-ts";
import { type GitignoreRule, isGitignored, parseGitignore } from "./gitignore";
import {
  classifyPath,
  isGeneratedName,
  isSupportedLanguage,
  validateRelativePath,
} from "./policy";
import type {
  ConfinementMode,
  ExtractedFile,
  InventoryFile,
  RepositoryMapLimits,
  SkippedReason,
} from "./types";

export interface InventoryResult {
  files: InventoryFile[];
  digest: string;
  complete: boolean;
  skipped: Record<SkippedReason, number>;
  files_parsed: number;
  files_reused: number;
  cacheEntries: Map<string, ParseCacheEntry>;
}

export interface InventoryOptions {
  root: string;
  confinement?: ConfinementMode;
  limits: RepositoryMapLimits;
  previous: ReadonlyMap<string, ParseCacheEntry>;
  signal?: AbortSignal;
  check: () => void;
}

type ProcFdRootResolverForTest = (rootFd: number) => string | Promise<string>;

interface WalkDirectory {
  relativePath: string;
  expectedStat: Awaited<ReturnType<typeof lstat>>;
  absolutePath?: string;
  handle?: FileHandle;
}

export const BINARY_SNIFF_BYTES = 8192;
export const GENERATED_MARKER_WINDOW = 1024;
export const MAX_GENERATED_LINE_LENGTH = 2000;
export const MAX_AVERAGE_LINE_LENGTH = 300;

const reasons: SkippedReason[] = [
  "ignored",
  "gitignored",
  "secret",
  "private_state",
  "dependency",
  "generated",
  "binary",
  "too_large",
  "symlink",
  "invalid_name",
  "limit",
];

export function inventory(options: InventoryOptions): Promise<InventoryResult> {
  return inventoryInternal(options);
}

export function inventoryWithProcFdRootForTest(
  options: InventoryOptions,
  resolveProcFdRoot: ProcFdRootResolverForTest,
): Promise<InventoryResult> {
  return inventoryInternal(options, resolveProcFdRoot);
}

async function inventoryInternal(
  options: InventoryOptions,
  resolveProcFdRootForTest?: ProcFdRootResolverForTest,
): Promise<InventoryResult> {
  const files: InventoryFile[] = [];
  const skipped = Object.fromEntries(
    reasons.map((reason) => [reason, 0]),
  ) as Record<SkippedReason, number>;
  const cacheEntries = new Map<string, ParseCacheEntry>();
  let totalBytes = 0;
  let entriesVisited = 0;
  let complete = true;
  let filesParsed = 0;
  let filesReused = 0;

  const skip = (reason: SkippedReason) => {
    skipped[reason] += 1;
  };
  const skipCount = (reason: SkippedReason, count: number) => {
    skipped[reason] += count;
  };
  const check = () => {
    if (options.signal?.aborted) throw new ContextCancelledError();
    options.check();
  };
  const stopForLimit = () => {
    complete = false;
    skip("limit");
    return true;
  };
  const realRoot = options.root;
  const confinement = options.confinement ?? "anchored";
  let procFdRoot = "/proc/self/fd";
  let rootStat: Awaited<ReturnType<typeof lstat>>;
  try {
    rootStat = await lstat(realRoot);
  } catch (error) {
    throw asIoError(error);
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new ContextIoError();
  }

  let rootHandle: FileHandle | undefined;
  let rootDirectory: WalkDirectory;
  if (confinement === "anchored") {
    const anchoredRoot = await openAnchoredRoot(
      realRoot,
      rootStat,
      resolveProcFdRootForTest,
    );
    rootHandle = anchoredRoot.handle;
    procFdRoot = anchoredRoot.procFdRoot;
    rootDirectory = {
      relativePath: "",
      expectedStat: rootStat,
      handle: rootHandle,
    };
  } else {
    rootDirectory = {
      relativePath: "",
      expectedStat: rootStat,
      absolutePath: realRoot,
    };
  }

  const walk = async (
    directory: WalkDirectory,
    inheritedRules: readonly {
      prefix: string;
      rules: readonly GitignoreRule[];
    }[],
  ): Promise<void> => {
    const directoryStillSafe = () =>
      directoryIsSafe(directory, realRoot, confinement);
    check();
    if (!(await directoryStillSafe())) {
      skip("symlink");
      return;
    }
    const relativeDirectory = directory.relativePath;
    const absoluteDirectory =
      confinement === "anchored"
        ? procFdPath(directory.handle as FileHandle, procFdRoot)
        : (directory.absolutePath as string);
    const rules = [...inheritedRules];
    const gitignore = await loadGitignoreRules(
      absoluteDirectory,
      relativeDirectory,
      confinement,
      realRoot,
      options.limits,
      totalBytes,
    );
    if (gitignore.kind === "limit") {
      stopForLimit();
      return;
    }
    if (gitignore.kind === "skipped") skip(gitignore.reason);
    if (gitignore.kind === "loaded") {
      totalBytes += gitignore.bytes;
      rules.push({ prefix: relativeDirectory, rules: gitignore.rules });
    }

    let names: string[];
    try {
      names = await readdir(absoluteDirectory);
    } catch (error) {
      if (!(await directoryStillSafe())) {
        skip("symlink");
        return;
      }
      if (isSymlinkRace(error)) {
        skip("symlink");
        return;
      }
      if (isMissing(error)) return;
      throw asIoError(error);
    }
    if (!(await directoryStillSafe())) {
      skip("symlink");
      return;
    }
    names.sort(compare);
    for (const name of names) {
      check();
      if (!(await directoryStillSafe())) {
        skip("symlink");
        return;
      }
      entriesVisited += 1;
      if (entriesVisited > options.limits.maxDirectoryEntries) {
        stopForLimit();
        return;
      }
      const relative = relativeDirectory
        ? `${relativeDirectory}/${name}`
        : name;
      const absolute = join(absoluteDirectory, name);
      try {
        validateRelativePath(relative, options.limits);
      } catch {
        skip("invalid_name");
        continue;
      }
      let stat: Awaited<ReturnType<typeof lstat>>;
      try {
        stat = await lstat(absolute);
      } catch (error) {
        if (isMissing(error)) continue;
        throw asIoError(error);
      }
      if (stat.isSymbolicLink()) {
        skip("symlink");
        continue;
      }
      if (!stat.isDirectory() && !stat.isFile()) continue;
      if (isGitignored(relative, stat.isDirectory(), rules)) {
        skip("gitignored");
        continue;
      }
      const policyReason = classifyPath(relative);
      if (policyReason) {
        skip(policyReason);
        continue;
      }
      if (stat.isDirectory()) {
        const child = await openChildDirectory(
          absolute,
          relative,
          stat,
          confinement,
        );
        if (!child) {
          skip("symlink");
          continue;
        }
        try {
          await walk(child, rules);
        } finally {
          await child.handle?.close().catch(() => undefined);
        }
        if (!complete) return;
        continue;
      }
      if (name === ".gitignore" || !isSupportedLanguage(relative)) continue;
      if (isGeneratedName(relative)) {
        skip("generated");
        continue;
      }
      if (stat.size > options.limits.maxFileBytes) {
        skip("too_large");
        continue;
      }
      if (files.length >= options.limits.maxFiles) {
        stopForLimit();
        return;
      }
      if (totalBytes + stat.size > options.limits.maxTotalBytes) {
        stopForLimit();
        return;
      }
      let bytes: Buffer;
      try {
        bytes = await readNoFollow(
          absolute,
          stat,
          confinement,
          realRoot,
          relative,
        );
      } catch (error) {
        if (isMissing(error)) continue;
        if (isSymlinkRace(error)) {
          skip("symlink");
          continue;
        }
        throw asIoError(error);
      }
      totalBytes += bytes.length;
      const content = classifyFileContent(bytes);
      if (content.kind === "skipped") {
        skip(content.reason);
        continue;
      }
      const { text } = content;
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const extractor = selectExtractor(relative);
      const previous = options.previous.get(relative);
      let parsed: ExtractedFile;
      if (
        previous &&
        previous.sha256 === sha256 &&
        previous.extractorVersion === extractor.version
      ) {
        parsed = previous;
        filesReused += 1;
      } else {
        parsed = extractor.extract(
          relative,
          text,
          options.limits.maxSymbolsPerFile,
        );
        filesParsed += 1;
      }
      const entry: ParseCacheEntry = {
        sha256,
        extractorVersion: extractor.version,
        defs: parsed.defs,
        refs: parsed.refs,
        droppedSymbols: parsed.droppedSymbols ?? 0,
      };
      cacheEntries.set(relative, entry);
      files.push({
        path: relative,
        sha256,
        text,
        size: bytes.length,
        defs: entry.defs,
        refs: entry.refs,
      });
      if (parsed.droppedSymbols) {
        skipCount("limit", parsed.droppedSymbols);
      }
    }
  };

  try {
    await walk(rootDirectory, []);
  } finally {
    if (rootHandle) await rootHandle.close().catch(() => undefined);
  }
  files.sort((left, right) => compare(left.path, right.path));
  const digest = createHash("sha256")
    .update(files.map((file) => `${file.path}\0${file.sha256}\n`).join(""))
    .digest("hex");
  return {
    files,
    digest,
    complete,
    skipped,
    files_parsed: filesParsed,
    files_reused: filesReused,
    cacheEntries,
  };
}

type GitignoreLoad =
  | { kind: "absent" }
  | { kind: "loaded"; rules: GitignoreRule[]; bytes: number }
  | { kind: "skipped"; reason: SkippedReason }
  | { kind: "limit" };

async function loadGitignoreRules(
  absoluteDirectory: string,
  relativeDirectory: string,
  confinement: ConfinementMode,
  realRoot: string,
  limits: RepositoryMapLimits,
  totalBytes: number,
): Promise<GitignoreLoad> {
  const ignorePath = join(absoluteDirectory, ".gitignore");
  const ignoreRelativePath = relativeDirectory
    ? `${relativeDirectory}/.gitignore`
    : ".gitignore";
  try {
    const stat = await lstat(ignorePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return { kind: "absent" };
    if (stat.size > limits.maxFileBytes) {
      return { kind: "skipped", reason: "too_large" };
    }
    if (totalBytes + stat.size > limits.maxTotalBytes) return { kind: "limit" };
    const contents = await readNoFollow(
      ignorePath,
      stat,
      confinement,
      realRoot,
      ignoreRelativePath,
    );
    return {
      kind: "loaded",
      rules: parseGitignore(contents.toString("utf8")),
      bytes: contents.length,
    };
  } catch (error) {
    if (isSymlinkRace(error)) return { kind: "skipped", reason: "symlink" };
    if (isMissing(error)) return { kind: "absent" };
    throw asIoError(error);
  }
}

async function openChildDirectory(
  absolutePath: string,
  relativePath: string,
  expectedStat: Awaited<ReturnType<typeof lstat>>,
  confinement: ConfinementMode,
): Promise<WalkDirectory | undefined> {
  if (confinement !== "anchored") {
    return { relativePath, expectedStat, absolutePath };
  }
  let handle: FileHandle | undefined;
  try {
    handle = await openAnchoredDirectory(absolutePath, expectedStat);
  } catch (error) {
    throw asIoError(error);
  }
  return handle ? { relativePath, expectedStat, handle } : undefined;
}

export type FileContentClassification =
  | { kind: "source"; text: string }
  | { kind: "skipped"; reason: "binary" | "generated" | "secret" };

export function classifyFileContent(
  bytes: Uint8Array,
): FileContentClassification {
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    return { kind: "skipped", reason: "binary" };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { kind: "skipped", reason: "binary" };
  }
  if (looksGenerated(text)) return { kind: "skipped", reason: "generated" };
  if (text.includes("-----BEGIN") && text.includes("PRIVATE KEY-----")) {
    return { kind: "skipped", reason: "secret" };
  }
  return { kind: "source", text };
}

function looksGenerated(text: string): boolean {
  const header = text.slice(0, GENERATED_MARKER_WINDOW);
  if (header.includes("@generated") || header.includes("DO NOT EDIT")) {
    return true;
  }
  const lines = text.split(/\r?\n/);
  if (lines.some((line) => line.length > MAX_GENERATED_LINE_LENGTH)) {
    return true;
  }
  return (
    text.length > 0 &&
    text.length / Math.max(1, lines.length) > MAX_AVERAGE_LINE_LENGTH
  );
}

export interface Extractor {
  version: string;
  extract: (
    relative: string,
    text: string,
    maxSymbols: number,
  ) => ExtractedFile;
}

const PYTHON_EXTRACTOR: Extractor = {
  version: PYTHON_EXTRACTOR_VERSION,
  extract: (_relative, text, maxSymbols) => extractPython(text, maxSymbols),
};

const TYPESCRIPT_EXTRACTOR: Extractor = {
  version: TS_EXTRACTOR_VERSION,
  extract: extractTypeScript,
};

export function selectExtractor(relative: string): Extractor {
  return relative.toLowerCase().endsWith(".py")
    ? PYTHON_EXTRACTOR
    : TYPESCRIPT_EXTRACTOR;
}

async function readNoFollow(
  path: string,
  expectedStat: Awaited<ReturnType<typeof lstat>>,
  confinement: ConfinementMode,
  realRoot: string,
  relativePath: string,
): Promise<Buffer> {
  const expectedDirectory =
    confinement === "best-effort"
      ? dirname(join(realRoot, relativePath))
      : undefined;
  if (expectedDirectory) {
    await verifyExpectedDirectory(dirname(path), expectedDirectory);
  }
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    if (expectedDirectory) {
      await verifyExpectedDirectory(dirname(path), expectedDirectory);
    }
    const openedStat = await handle.stat();
    if (
      !openedStat.isFile() ||
      openedStat.dev !== expectedStat.dev ||
      openedStat.ino !== expectedStat.ino
    ) {
      throw new FileIdentityMismatchError();
    }
    return await handle.readFile();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function openAnchoredRoot(
  realRoot: string,
  expectedStat: Awaited<ReturnType<typeof lstat>>,
  resolveProcFdRootForTest?: ProcFdRootResolverForTest,
): Promise<{ handle: FileHandle; procFdRoot: string }> {
  if (
    typeof constants.O_DIRECTORY !== "number" ||
    typeof constants.O_NOFOLLOW !== "number"
  ) {
    throw new ContextConfinementUnavailableError();
  }
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      realRoot,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const openedStat = await handle.stat();
    if (
      !openedStat.isDirectory() ||
      openedStat.dev !== expectedStat.dev ||
      openedStat.ino !== expectedStat.ino
    ) {
      throw new FileIdentityMismatchError();
    }
  } catch {
    if (handle) await handle.close().catch(() => undefined);
    throw new ContextIoError();
  }
  if (!handle) throw new ContextIoError();

  let procFdRoot: string;
  try {
    procFdRoot = resolveProcFdRootForTest
      ? await resolveProcFdRootForTest(handle.fd)
      : "/proc/self/fd";
    const expectedProcFdRoot = `/proc/${process.pid}/fd`;
    if (
      (await realpath("/proc/self/fd")) !== expectedProcFdRoot ||
      (await realpath(procFdRoot)) !== expectedProcFdRoot
    ) {
      throw new Error();
    }
    const statfs = (
      fsPromises as unknown as {
        statfs?: (path: string) => Promise<{ type: number | bigint }>;
      }
    ).statfs;
    if (typeof statfs === "function") {
      const filesystem = await statfs(procFdRoot);
      if (Number(filesystem.type) !== 0x9fa0) throw new Error();
    } else {
      // Realpath and fd-link identity are the fallback when statfs is unavailable.
    }
    const procPath = procFdPath(handle, procFdRoot);
    const fdLinkStat = await lstat(procPath);
    await readdir(procPath);
    const procStat = await stat(procPath);
    const openedStat = await handle.stat();
    if (
      !fdLinkStat.isSymbolicLink() ||
      !procStat.isDirectory() ||
      procStat.dev !== openedStat.dev ||
      procStat.ino !== openedStat.ino
    ) {
      throw new Error();
    }
  } catch {
    await handle.close().catch(() => undefined);
    throw new ContextConfinementUnavailableError();
  }
  return { handle, procFdRoot };
}

async function openAnchoredDirectory(
  path: string,
  expectedStat: Awaited<ReturnType<typeof lstat>>,
): Promise<FileHandle | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY |
        (constants.O_DIRECTORY ?? 0) |
        (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (isMissing(error) || isSymlinkRace(error) || code === "ENOTDIR") {
      return undefined;
    }
    throw error;
  }
  try {
    const openedStat = await handle.stat();
    if (
      !openedStat.isDirectory() ||
      openedStat.dev !== expectedStat.dev ||
      openedStat.ino !== expectedStat.ino
    ) {
      await handle.close().catch(() => undefined);
      return undefined;
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (isMissing(error) || isSymlinkRace(error)) return undefined;
    throw error;
  }
}

function procFdPath(handle: FileHandle, procFdRoot: string): string {
  return join(procFdRoot, String(handle.fd));
}

async function directoryIsSafe(
  directory: WalkDirectory,
  realRoot: string,
  confinement: ConfinementMode,
): Promise<boolean> {
  if (confinement === "anchored") {
    try {
      const currentStat = await directory.handle?.stat();
      return Boolean(
        currentStat?.isDirectory() &&
          currentStat.dev === directory.expectedStat.dev &&
          currentStat.ino === directory.expectedStat.ino,
      );
    } catch {
      return false;
    }
  }
  if (!directory.absolutePath) return false;
  return directoryMatchesRoot(
    directory.absolutePath,
    directory.relativePath,
    realRoot,
    directory.expectedStat,
  );
}

async function directoryMatchesRoot(
  absoluteDirectory: string,
  relativeDirectory: string,
  realRoot: string,
  expectedStat: Awaited<ReturnType<typeof lstat>>,
): Promise<boolean> {
  let currentStat: Awaited<ReturnType<typeof lstat>>;
  try {
    currentStat = await lstat(absoluteDirectory);
  } catch (error) {
    if (isMissing(error) || isSymlinkRace(error)) return false;
    throw asIoError(error);
  }
  if (
    !currentStat.isDirectory() ||
    currentStat.isSymbolicLink() ||
    currentStat.dev !== expectedStat.dev ||
    currentStat.ino !== expectedStat.ino
  ) {
    return false;
  }
  const expectedPath = relativeDirectory
    ? join(realRoot, relativeDirectory)
    : realRoot;
  try {
    return (await realpath(absoluteDirectory)) === expectedPath;
  } catch (error) {
    if (isMissing(error) || isSymlinkRace(error)) return false;
    throw asIoError(error);
  }
}

async function verifyExpectedDirectory(
  directory: string,
  expectedDirectory: string,
): Promise<void> {
  try {
    if ((await realpath(directory)) !== expectedDirectory) {
      throw new FileIdentityMismatchError();
    }
  } catch {
    throw new FileIdentityMismatchError();
  }
}

class FileIdentityMismatchError extends Error {
  constructor() {
    super("Opened file identity changed during inventory");
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isSymlinkRace(error: unknown): boolean {
  if (error instanceof FileIdentityMismatchError) return true;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ELOOP" || code === "EMLINK";
}

function asIoError(_error: unknown): ContextIoError {
  return new ContextIoError();
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
