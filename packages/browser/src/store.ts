import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import {
  isInsideOrEqual,
  resolveForSafety,
} from "@mars/contracts/path-containment";
import { BrowserError } from "./errors";

export const BROWSER_STORE_FORMAT_VERSION = 1;
const DB_FILE = "browser.sqlite";

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function timestamp(now: number): string {
  return new Date(now).toISOString();
}

export interface OpenBrowserStore {
  readonly db: Database;
  readonly rootDir: string;
  /** Host private roots in both requested and resolved form. */
  readonly privateRoots: ReadonlySet<string>;
  close(): void;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS jobs (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_key TEXT NOT NULL,
    request_id TEXT NOT NULL,
    idem_request_id TEXT NOT NULL,
    scope_json TEXT NOT NULL,
    record_json TEXT NOT NULL,
    record_sha256 TEXT NOT NULL,
    task_id TEXT NOT NULL,
    task_revision INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled','expired')),
    stale INTEGER NOT NULL DEFAULT 0,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL,
    available_at INTEGER NOT NULL,
    lease_owner TEXT,
    lease_token TEXT,
    lease_expires_at INTEGER,
    submitted_at TEXT NOT NULL,
    deadline TEXT NOT NULL,
    finished_at TEXT,
    error_code TEXT,
    usage_json TEXT NOT NULL,
    worker_json TEXT,
    UNIQUE (scope_key, request_id),
    UNIQUE (scope_key, idem_request_id)
  );
  CREATE INDEX IF NOT EXISTS jobs_task ON jobs (scope_key, task_id);
  CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status, available_at);
  CREATE TABLE IF NOT EXISTS steps (
    scope_key TEXT NOT NULL,
    request_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    step_index INTEGER NOT NULL,
    step_json TEXT NOT NULL,
    PRIMARY KEY (scope_key, request_id, attempt, step_index)
  );
  CREATE TABLE IF NOT EXISTS results (
    scope_key TEXT NOT NULL,
    request_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    result_json TEXT NOT NULL,
    PRIMARY KEY (scope_key, request_id)
  );
  CREATE TABLE IF NOT EXISTS evidence (
    scope_key TEXT NOT NULL,
    request_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    artifact_id TEXT NOT NULL,
    ref_json TEXT NOT NULL,
    kind TEXT NOT NULL,
    url TEXT NOT NULL,
    PRIMARY KEY (scope_key, request_id, artifact_id)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    scope_key TEXT NOT NULL,
    task_id TEXT NOT NULL,
    session_key TEXT NOT NULL,
    data BLOB NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (scope_key, task_id, session_key)
  );
`;

function unsafe(message: string): BrowserError {
  return new BrowserError("unsafe_path", message);
}

/** Opens the 0700 store directory, refusing symlinks, foreign owners and private-root overlap. */
export function openBrowserStore(options: {
  rootDir: string;
  hostPrivateRoots?: readonly string[];
}): OpenBrowserStore {
  if (!path.isAbsolute(options.rootDir))
    throw new BrowserError("invalid_input", "rootDir must be absolute");
  const requestedRoot = path.resolve(options.rootDir);
  const privateRoots = new Set<string>();
  for (const candidate of options.hostPrivateRoots ?? []) {
    if (
      typeof candidate !== "string" ||
      !path.isAbsolute(candidate) ||
      path.resolve(candidate) === path.parse(path.resolve(candidate)).root
    )
      throw new BrowserError(
        "invalid_input",
        "hostPrivateRoots must be absolute non-root paths",
      );
    privateRoots.add(path.resolve(candidate));
    privateRoots.add(resolveForSafety(candidate));
  }
  const overlaps = (root: string) =>
    [...privateRoots].some(
      (privateRoot) =>
        isInsideOrEqual(root, privateRoot) || isInsideOrEqual(privateRoot, root),
    );
  if (overlaps(resolveForSafety(requestedRoot)))
    throw unsafe("Browser store root overlaps a private path");
  let rootStat: ReturnType<typeof lstatSync> | undefined;
  try {
    rootStat = lstatSync(requestedRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw unsafe("Browser store root is unsafe");
  }
  if (rootStat) {
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
      throw unsafe("Browser store root must be a real directory");
    if (
      typeof process.getuid === "function" &&
      rootStat.uid !== process.getuid()
    )
      throw unsafe("Browser store root must be owned by the current user");
    const entries = readdirSync(requestedRoot);
    if (entries.length > 0 && !entries.includes(DB_FILE))
      throw unsafe("Browser store root is not empty and has no database");
  } else {
    try {
      mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
    } catch {
      throw unsafe("Browser store root is unsafe");
    }
  }
  chmodSync(requestedRoot, 0o700);
  const rootDir = realpathSync(requestedRoot);
  if (overlaps(rootDir))
    throw unsafe("Browser store root overlaps a private path");
  const db = new Database(path.join(rootDir, DB_FILE), {
    create: true,
    strict: true,
  });
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = FULL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(SCHEMA);
    const version = db
      .query("SELECT value FROM meta WHERE key = 'format_version'")
      .get() as { value: string } | null;
    if (!version) {
      db.query(
        "INSERT INTO meta (key, value) VALUES ('format_version', ?)",
      ).run(String(BROWSER_STORE_FORMAT_VERSION));
    } else if (version.value !== String(BROWSER_STORE_FORMAT_VERSION)) {
      throw new BrowserError(
        "corrupt_record",
        "Unsupported browser store format",
      );
    }
    chmodSync(path.join(rootDir, DB_FILE), 0o600);
  } catch (error) {
    db.close();
    throw error;
  }
  return {
    db,
    rootDir,
    privateRoots,
    close: () => db.close(),
  };
}
