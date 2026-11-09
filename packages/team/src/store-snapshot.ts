import { z } from "zod";
import { conflict, invalidInput } from "./errors";
import type { TeamStore } from "./store";
import { TEAM_MIGRATIONS, TEAM_STORE_FORMAT_VERSION } from "./store-migrations";
import type { StoreScope } from "./store-scope";

/** Tables `exportSnapshot` dumps, in foreign-key order so `importSnapshot` can replay them. */
export const TEAM_SNAPSHOT_TABLES = [
  "members",
  "conversations",
  "participants",
  "messages",
  "reactions",
  "outbox",
  "idempotency",
  "task_links",
  "result_shares",
  "repos",
  "repo_access",
  "code_references",
  "message_references",
  "agent_requests",
  "metrics",
] as const;
export const TEAM_SNAPSHOT_SCHEMA_VERSION = 1;
const sqlValue = z.union([z.string(), z.number(), z.null()]);
/**
 * `mars team export` output: every durable row of the store plus the ledger it
 * was written under. It never contains a credential because the store holds
 * none (dev tokens live in the CLI's token file, hashed in memory only).
 */
export const TeamStoreSnapshotSchema = z
  .object({
    schema_version: z.literal(TEAM_SNAPSHOT_SCHEMA_VERSION),
    format_version: z.literal(TEAM_STORE_FORMAT_VERSION),
    ledger: z.array(z.string().min(1).max(128)).max(1000),
    /** The kill-switch state at export time; `importSnapshot` records it but leaves the restored store disabled. */
    enabled: z.boolean(),
    exported_at: z.string().datetime({ offset: true }),
    tables: z.record(
      z.enum(TEAM_SNAPSHOT_TABLES),
      z.array(z.record(z.string().regex(/^[a-z_][a-z0-9_]*$/), sqlValue)),
    ),
  })
  .strict();
export type TeamStoreSnapshot = z.infer<typeof TeamStoreSnapshotSchema>;

/** Host-only `mars team export|import` over every durable table. */
export function snapshotOperations(
  scope: StoreScope,
): Pick<TeamStore, "exportSnapshot" | "importSnapshot"> {
  const { db, timestamp, readEnabled, write, read } = scope;
  const snapshotColumns = (table: string): string[] =>
    db
      .query<{ name: string }, []>(`PRAGMA table_info("${table}")`)
      .all()
      .map((column) => column.name);

  return {
    exportSnapshot() {
      return read(() => {
        const tables: Record<string, Record<string, string | number | null>[]> =
          {};
        for (const table of TEAM_SNAPSHOT_TABLES)
          tables[table] = db
            .query<Record<string, string | number | null>, []>(
              `SELECT * FROM "${table}" ORDER BY rowid`,
            )
            .all();
        return TeamStoreSnapshotSchema.parse({
          schema_version: TEAM_SNAPSHOT_SCHEMA_VERSION,
          format_version: TEAM_STORE_FORMAT_VERSION,
          ledger: TEAM_MIGRATIONS.map((migration) => migration.id),
          enabled: readEnabled(),
          exported_at: timestamp(),
          tables,
        });
      });
    },
    importSnapshot(raw) {
      const parsed = TeamStoreSnapshotSchema.safeParse(raw);
      if (!parsed.success) throw invalidInput("Invalid team store snapshot");
      const snapshot = parsed.data;
      const ledger = TEAM_MIGRATIONS.map((migration) => migration.id);
      if (
        snapshot.ledger.length !== ledger.length ||
        snapshot.ledger.some((id, index) => id !== ledger[index])
      )
        throw conflict(
          "Snapshot was exported under a different migration ledger",
        );
      // A partial snapshot is not a restore: every table must be present (empty arrays included).
      for (const table of TEAM_SNAPSHOT_TABLES)
        if (!snapshot.tables[table])
          throw invalidInput("Snapshot is missing a table");
      return write(() => {
        for (const table of TEAM_SNAPSHOT_TABLES) {
          const count =
            db
              .query<{ count: number }, []>(
                `SELECT COUNT(*) AS count FROM "${table}"`,
              )
              .get()?.count ?? 0;
          if (count > 0)
            throw conflict("Refusing to import into a non-empty team store");
        }
        let rows = 0;
        let tables = 0;
        for (const table of TEAM_SNAPSHOT_TABLES) {
          const incoming = snapshot.tables[table];
          if (!incoming) continue;
          tables += 1;
          const columns = snapshotColumns(table);
          const columnSet = new Set(columns);
          const insert = db.query(
            `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
          );
          for (const row of incoming) {
            const keys = Object.keys(row);
            if (
              keys.length !== columns.length ||
              keys.some((key) => !columnSet.has(key))
            )
              throw invalidInput("Snapshot row does not match the table");
            insert.run(...columns.map((column) => row[column] ?? null));
            rows += 1;
          }
        }
        return { tables, rows };
      });
    },
  };
}
