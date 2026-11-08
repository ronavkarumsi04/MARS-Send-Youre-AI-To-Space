import { referenceDigest } from "@mars/code-refs";
import {
  type GitRangeReference,
  GitRangeReferenceSchema,
  type Repo,
  type RepoAccess,
  RepoAccessSchema,
  RepoSchema,
} from "@mars/contracts";
import { z } from "zod";
import { invalidInput, referenceNotFound, TeamError } from "./errors";
import type { TeamStore } from "./store";
import { canonicalJson, idSchema, sha256 } from "./store-db";
import type { RepoAccessRow, RepoRow, StoreScope } from "./store-scope";

/** Host-trusted repos, per-user repo access and stored code references. */
export function referenceOperations(
  scope: StoreScope,
): Pick<
  TeamStore,
  | "getReferences"
  | "setRepo"
  | "setRepoAccess"
  | "repoAccessState"
  | "revokeRepoAccess"
  | "listRepos"
  | "hasRepoAccess"
  | "requireRepoAccess"
  | "putReference"
  | "viewReference"
> {
  const {
    db,
    limits,
    timestamp,
    requireTeamMember,
    repoRow,
    repoAccessRow,
    repoAccessible,
    referenceRow,
    referenceRecord,
    write,
    read,
  } = scope;
  const toRepo = (row: RepoRow): Repo =>
    RepoSchema.parse({
      team_id: row.team_id,
      repo_id: row.repo_id,
      label: row.label,
      revision: row.revision,
    });
  const toRepoAccess = (row: RepoAccessRow): RepoAccess =>
    RepoAccessSchema.parse({
      team_id: row.team_id,
      repo_id: row.repo_id,
      user_id: row.user_id,
      state: row.state,
      revision: row.revision,
    });
  const setAccess = (
    input: { team_id: string; repo_id: string; user_id: string },
    state: "active" | "removed",
  ): RepoAccess => {
    const parsed = z
      .object({ team_id: idSchema, repo_id: idSchema, user_id: idSchema })
      .strict()
      .safeParse(input);
    if (!parsed.success) throw invalidInput("Invalid repo access input");
    if (!repoRow(parsed.data.team_id, parsed.data.repo_id))
      throw referenceNotFound();
    const existing = repoAccessRow(
      parsed.data.team_id,
      parsed.data.repo_id,
      parsed.data.user_id,
    );
    const revision = (existing?.revision ?? 0) + 1;
    db.query(
      "INSERT INTO repo_access (team_id, repo_id, user_id, state, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (team_id, repo_id, user_id) DO UPDATE SET state = excluded.state, revision = excluded.revision, updated_at = excluded.updated_at",
    ).run(
      parsed.data.team_id,
      parsed.data.repo_id,
      parsed.data.user_id,
      state,
      revision,
      timestamp(),
      timestamp(),
    );
    const row = repoAccessRow(
      parsed.data.team_id,
      parsed.data.repo_id,
      parsed.data.user_id,
    );
    if (!row) throw new TeamError("corrupt_record", "Repo access write failed");
    return toRepoAccess(row);
  };
  return {
    getReferences(teamId, referenceIds) {
      if (!idSchema.safeParse(teamId).success) return [];
      return read(() =>
        [...new Set(referenceIds)].flatMap((referenceId) => {
          if (!idSchema.safeParse(referenceId).success) return [];
          const row = referenceRow(teamId, referenceId);
          return row ? [referenceRecord(row)] : [];
        }),
      );
    },
    setRepo(input) {
      return write(() => {
        const parsed = z
          .object({
            team_id: idSchema,
            repo_id: idSchema,
            label: z.string().min(1).max(limits.max_title_chars),
          })
          .strict()
          .safeParse(input);
        if (!parsed.success) throw invalidInput("Invalid repo input");
        const existing = repoRow(parsed.data.team_id, parsed.data.repo_id);
        const revision = (existing?.revision ?? 0) + 1;
        db.query(
          "INSERT INTO repos (team_id, repo_id, label, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (team_id, repo_id) DO UPDATE SET label = excluded.label, revision = excluded.revision, updated_at = excluded.updated_at",
        ).run(
          parsed.data.team_id,
          parsed.data.repo_id,
          parsed.data.label,
          revision,
          timestamp(),
          timestamp(),
        );
        const row = repoRow(parsed.data.team_id, parsed.data.repo_id);
        if (!row) throw new TeamError("corrupt_record", "Repo write failed");
        return toRepo(row);
      });
    },
    setRepoAccess(input) {
      return write(() => setAccess(input, "active"));
    },
    repoAccessState(input) {
      const row = read(() =>
        repoAccessRow(input.team_id, input.repo_id, input.user_id),
      );
      return row ? toRepoAccess(row).state : null;
    },
    revokeRepoAccess(input) {
      return write(() => setAccess(input, "removed"));
    },
    listRepos(actor) {
      return read(() => {
        requireTeamMember(actor);
        return db
          .query<RepoRow, [string, string]>(
            "SELECT r.team_id, r.repo_id, r.label, r.revision FROM repos r JOIN repo_access a ON a.team_id = r.team_id AND a.repo_id = r.repo_id WHERE r.team_id = ? AND a.user_id = ? AND a.state = 'active' ORDER BY r.repo_id",
          )
          .all(actor.team_id, actor.user_id)
          .map(toRepo);
      });
    },
    hasRepoAccess(actor, repoId) {
      return read(() => repoAccessible(actor, repoId));
    },
    requireRepoAccess(actor, repoId) {
      read(() => {
        requireTeamMember(actor);
        if (!repoAccessible(actor, repoId)) throw referenceNotFound();
      });
    },
    putReference(actor, input) {
      return write(() => {
        requireTeamMember(actor);
        if (!repoAccessible(actor, input.locator.repo_id))
          throw referenceNotFound();
        if (input.resolved_state === "unavailable") throw referenceNotFound();
        const record: GitRangeReference = GitRangeReferenceSchema.parse({
          kind: "git_range",
          reference_id: referenceDigest(input.locator),
          team_id: actor.team_id,
          repo_id: input.locator.repo_id,
          commit_sha: input.locator.commit_sha,
          path: input.locator.path,
          line_start: input.locator.line_start,
          line_end: input.locator.line_end,
          blob_sha256: input.blob_sha256,
        });
        const existing = referenceRow(actor.team_id, record.reference_id);
        if (existing) return referenceRecord(existing);
        db.query(
          "INSERT INTO code_references (team_id, reference_id, kind, repo_id, commit_sha, path, line_start, line_end, blob_sha256, resolved_state, created_by, created_at, record_sha256) VALUES (?, ?, 'git_range', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          record.team_id,
          record.reference_id,
          record.repo_id,
          record.commit_sha,
          record.path,
          record.line_start,
          record.line_end,
          record.blob_sha256,
          input.resolved_state,
          actor.user_id,
          timestamp(),
          sha256(canonicalJson(record)),
        );
        return record;
      });
    },
    viewReference(actor, referenceId) {
      return read(() => {
        requireTeamMember(actor);
        if (!idSchema.safeParse(referenceId).success) throw referenceNotFound();
        const visible = db
          .query<{ one: number }, [string, string, string]>(
            `SELECT 1 AS one FROM message_references mr
             JOIN messages m ON m.message_id = mr.message_id
             JOIN conversations c ON c.conversation_id = m.conversation_id
             JOIN participants p ON p.conversation_id = m.conversation_id AND p.user_id = ?
             WHERE mr.team_id = ? AND mr.reference_id = ? AND c.team_id = mr.team_id
               AND p.state = 'active' AND m.seq > p.joined_seq
             LIMIT 1`,
          )
          .get(actor.user_id, actor.team_id, referenceId);
        const row = referenceRow(actor.team_id, referenceId);
        if (!visible || !row) throw referenceNotFound();
        return {
          reference: referenceRecord(row),
          accessible: repoAccessible(actor, row.repo_id),
        };
      });
    },
  };
}
