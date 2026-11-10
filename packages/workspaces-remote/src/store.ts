import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ArtifactRefSchema } from "@mars/contracts";
import { IntegrityError, ProviderLockedError } from "@mars/workspaces";
import { z } from "zod";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const relPath = z.string().min(1).max(4096);

export const ManifestFileSchema = z
  .object({
    path: relPath,
    mode: z.union([z.literal(420), z.literal(493)]),
    size: z.number().int().nonnegative(),
    sha256: sha,
  })
  .strict();
export type ManifestFile = z.infer<typeof ManifestFileSchema>;

export const SkippedSchema = z
  .object({
    path: relPath,
    reason: z.enum([
      "symlink",
      "special",
      "ignored-secret",
      "unsupported-name",
    ]),
  })
  .strict();
export type SkippedEntry = z.infer<typeof SkippedSchema>;

/** The tree MARS believes the remote holds; the remote is checked against it. */
export const TreeManifestSchema = z
  .object({
    files: z.array(ManifestFileSchema),
    directories: z.array(relPath),
    digest: sha,
  })
  .strict();
export type TreeManifest = z.infer<typeof TreeManifestSchema>;

const JournalSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("restore"),
      checkpoint_id: z.string(),
      target_counter: z.number().int().nonnegative(),
      target_digest: sha,
    })
    .strict(),
  /** A remote command may be running; on recovery stop it and adopt the tree. */
  z
    .object({
      kind: z.literal("execute"),
      command_id: z.string().max(256).nullable(),
    })
    .strict(),
]);
export type RestoreJournal = z.infer<typeof JournalSchema>;

export interface WorkspaceRow {
  workspace_id: string;
  owner_id: string;
  project_id: string;
  task_id: string;
  remote_root: string;
  counter: number;
  revision: string;
  manifest: TreeManifest;
  skipped: SkippedEntry[];
  baseline_checkpoint_id: string;
  created_at: string;
  journal: RestoreJournal | null;
}

export interface CheckpointRow {
  checkpoint_id: string;
  workspace_id: string;
  seq: number;
  revision: string;
  artifact: z.infer<typeof ArtifactRefSchema>;
}

/**
 * Durable MARS-side state of remote workspaces. The Agent Server holds file
 * bytes; this store holds identity, revision fencing, the expected tree
 * manifest, checkpoint lineage, the restore journal and the provider lease.
 */
export interface RemoteWorkspaceStore {
  get(workspaceId: string): WorkspaceRow | null;
  findByTask(owner: string, project: string, task: string): WorkspaceRow | null;
  insert(row: WorkspaceRow): void;
  update(row: WorkspaceRow): void;
  addCheckpoint(row: Omit<CheckpointRow, "seq">): void;
  checkpoint(checkpointId: string): CheckpointRow | null;
  checkpoints(workspaceId: string): CheckpointRow[];
  close(): void;
}

const LEASE_MS = 30_000;

export function openRemoteWorkspaceStore(
  rootDir: string,
  now: () => number = Date.now,
): RemoteWorkspaceStore {
  mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  const db = new Database(join(rootDir, "remote-workspaces.sqlite"), {
    create: true,
    strict: true,
  });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`CREATE TABLE IF NOT EXISTS workspaces (
    workspace_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    remote_root TEXT NOT NULL,
    counter INTEGER NOT NULL,
    revision TEXT NOT NULL,
    manifest TEXT NOT NULL,
    skipped TEXT NOT NULL,
    baseline_checkpoint_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    journal TEXT,
    UNIQUE (owner_id, project_id, task_id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS checkpoints (
    checkpoint_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
    seq INTEGER NOT NULL,
    revision TEXT NOT NULL,
    artifact TEXT NOT NULL,
    UNIQUE (workspace_id, seq)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS lease (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    holder TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`);
  const holder = randomUUID();
  const acquire = db.transaction(() => {
    const row = db
      .query("SELECT holder, expires_at FROM lease WHERE id = 1")
      .get() as { holder: string; expires_at: number } | null;
    if (row && row.holder !== holder && row.expires_at > now())
      throw new ProviderLockedError();
    db.query(
      "INSERT INTO lease (id, holder, expires_at) VALUES (1, ?1, ?2) ON CONFLICT(id) DO UPDATE SET holder = ?1, expires_at = ?2",
    ).run(holder, now() + LEASE_MS);
  });
  try {
    acquire.immediate();
  } catch (error) {
    db.close();
    throw error;
  }
  const renew = setInterval(() => {
    try {
      db.query(
        "UPDATE lease SET expires_at = ?1 WHERE id = 1 AND holder = ?2",
      ).run(now() + LEASE_MS, holder);
    } catch {
      // A failed renewal lets the lease lapse; the next write re-checks it.
    }
  }, LEASE_MS / 3);
  renew.unref?.();
  const assertLease = (): void => {
    const row = db.query("SELECT holder FROM lease WHERE id = 1").get() as {
      holder: string;
    } | null;
    if (row?.holder !== holder) throw new ProviderLockedError();
  };

  const decode = (raw: Record<string, unknown>): WorkspaceRow => {
    try {
      return {
        workspace_id: String(raw.workspace_id),
        owner_id: String(raw.owner_id),
        project_id: String(raw.project_id),
        task_id: String(raw.task_id),
        remote_root: String(raw.remote_root),
        counter: Number(raw.counter),
        revision: String(raw.revision),
        manifest: TreeManifestSchema.parse(JSON.parse(String(raw.manifest))),
        skipped: z.array(SkippedSchema).parse(JSON.parse(String(raw.skipped))),
        baseline_checkpoint_id: String(raw.baseline_checkpoint_id),
        created_at: String(raw.created_at),
        journal:
          raw.journal === null
            ? null
            : JournalSchema.parse(JSON.parse(String(raw.journal))),
      };
    } catch (error) {
      throw new IntegrityError("Remote workspace metadata is unreadable", {
        cause: error,
      });
    }
  };
  const decodeCheckpoint = (raw: Record<string, unknown>): CheckpointRow => {
    const artifact = ArtifactRefSchema.safeParse(
      JSON.parse(String(raw.artifact)),
    );
    if (!artifact.success)
      throw new IntegrityError("Remote checkpoint record is unreadable");
    return {
      checkpoint_id: String(raw.checkpoint_id),
      workspace_id: String(raw.workspace_id),
      seq: Number(raw.seq),
      revision: String(raw.revision),
      artifact: artifact.data,
    };
  };
  const params = (row: WorkspaceRow) =>
    [
      row.workspace_id,
      row.owner_id,
      row.project_id,
      row.task_id,
      row.remote_root,
      row.counter,
      row.revision,
      JSON.stringify(TreeManifestSchema.parse(row.manifest)),
      JSON.stringify(row.skipped),
      row.baseline_checkpoint_id,
      row.created_at,
      row.journal ? JSON.stringify(JournalSchema.parse(row.journal)) : null,
    ] as const;

  return {
    get(workspaceId) {
      const raw = db
        .query("SELECT * FROM workspaces WHERE workspace_id = ?1")
        .get(workspaceId) as Record<string, unknown> | null;
      return raw ? decode(raw) : null;
    },
    findByTask(owner, project, task) {
      const raw = db
        .query(
          "SELECT * FROM workspaces WHERE owner_id = ?1 AND project_id = ?2 AND task_id = ?3",
        )
        .get(owner, project, task) as Record<string, unknown> | null;
      return raw ? decode(raw) : null;
    },
    insert(row) {
      db.transaction(() => {
        assertLease();
        db.query(
          "INSERT INTO workspaces VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        ).run(...params(row));
      }).immediate();
    },
    update(row) {
      db.transaction(() => {
        assertLease();
        const [id, , , , , counter, revision, manifest, skipped, , , journal] =
          params(row);
        db.query(
          "UPDATE workspaces SET counter = ?2, revision = ?3, manifest = ?4, skipped = ?5, journal = ?6 WHERE workspace_id = ?1",
        ).run(id, counter, revision, manifest, skipped, journal);
      }).immediate();
    },
    addCheckpoint(row) {
      db.transaction(() => {
        assertLease();
        const next = db
          .query(
            "SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM checkpoints WHERE workspace_id = ?1",
          )
          .get(row.workspace_id) as { seq: number };
        db.query(
          "INSERT INTO checkpoints (checkpoint_id, workspace_id, seq, revision, artifact) VALUES (?1, ?2, ?3, ?4, ?5)",
        ).run(
          row.checkpoint_id,
          row.workspace_id,
          next.seq,
          row.revision,
          JSON.stringify(ArtifactRefSchema.parse(row.artifact)),
        );
      }).immediate();
    },
    checkpoint(checkpointId) {
      const raw = db
        .query("SELECT * FROM checkpoints WHERE checkpoint_id = ?1")
        .get(checkpointId) as Record<string, unknown> | null;
      return raw ? decodeCheckpoint(raw) : null;
    },
    checkpoints(workspaceId) {
      return (
        db
          .query(
            "SELECT * FROM checkpoints WHERE workspace_id = ?1 ORDER BY seq",
          )
          .all(workspaceId) as Record<string, unknown>[]
      ).map(decodeCheckpoint);
    },
    close() {
      clearInterval(renew);
      try {
        db.query("DELETE FROM lease WHERE id = 1 AND holder = ?1").run(holder);
      } finally {
        db.close();
      }
    },
  };
}
