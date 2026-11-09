import type { Database } from "bun:sqlite";
import {
  type GitRangeReference,
  GitRangeReferenceSchema,
  type Message,
  MessageSchema,
  type MessageView,
  MessageViewSchema,
  type ReferenceChip,
  ResultCardSchema,
  type ResultShare,
  ResultShareSchema,
  type TaskLink,
  TEAM_MAX_EXCERPT_CHARS,
  type TeamMembership,
  TeamMembershipSchema,
} from "@mars/contracts";
import { z } from "zod";
import type { TeamAgentOptions } from "./agent";
import { invalidInput, rateLimited, TeamError } from "./errors";
import {
  isTeamMetricCounter,
  metricsSnapshot,
  type TeamMetrics,
} from "./metrics";
import type { TeamLimits } from "./schemas";
import type { ReactionSummary, StoreNotice, TeamActor } from "./store";
import * as storeDb from "./store-db";
import {
  type ConversationRow,
  canonicalJson,
  idSchema,
  type MessageRow,
  type ParticipantRow,
  type StoreDbContext,
  sha256,
} from "./store-db";
import { headExcerpt } from "./text";

export const ENVELOPE_BYTES = Buffer.byteLength('{"result":[]}');

export interface MemberRow {
  team_id: string;
  user_id: string;
  role: string;
  state: string;
  revision: number;
}
export interface ResultShareRow {
  share_id: string;
  link_id: string;
  message_id: string;
  message_seq: number;
  preview_sha256: string;
  candidate_diff_sha256: string;
  evidence_sha256: string;
  card_json: string;
  created_at: string;
  record_sha256: string;
}
export interface RepoRow {
  team_id: string;
  repo_id: string;
  label: string;
  revision: number;
}
export interface RepoAccessRow {
  team_id: string;
  repo_id: string;
  user_id: string;
  state: string;
  revision: number;
}
export interface ReferenceRow {
  team_id: string;
  reference_id: string;
  kind: string;
  repo_id: string;
  commit_sha: string;
  path: string;
  line_start: number | null;
  line_end: number | null;
  blob_sha256: string | null;
  resolved_state: string;
  created_by: string;
  created_at: string;
  record_sha256: string;
}

/**
 * State and helpers every store operation group shares: the database, limits,
 * clock, the `write`/`read` transaction boundaries with post-commit notices,
 * team and conversation authorization, per-viewer message views and the
 * per-user rate limits. Operation groups (`store-*.ts`) receive it from
 * `createTeamStore` and never open their own database.
 */
export function createStoreScope(
  db: Database,
  options: {
    limits: TeamLimits;
    now: () => Date;
    randomId: () => string;
    agentOptions: TeamAgentOptions | undefined;
  },
) {
  const { limits, now, randomId, agentOptions } = options;
  const timestamp = () => now().toISOString();
  const metrics: TeamMetrics = {
    increment(name, by = 1) {
      if (!isTeamMetricCounter(name) || !Number.isInteger(by) || by < 0)
        throw invalidInput("Unknown metric counter");
      db.query(
        "INSERT INTO metrics (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = value + excluded.value",
      ).run(name, by);
    },
    snapshot() {
      return metricsSnapshot(
        db
          .query<{ name: string; value: number }, []>(
            "SELECT name, value FROM metrics",
          )
          .all(),
      );
    },
  };
  const ctx: StoreDbContext = {
    db,
    limits,
    clock: now,
    metrics,
    notify: (notice) => notify(notice),
  };
  const readEnabled = (): boolean =>
    db
      .query<{ value: string }, []>(
        "SELECT value FROM meta WHERE key = 'team.enabled'",
      )
      .get()?.value === "1";

  const memberRow = (teamId: string, userId: string): MemberRow | null =>
    db
      .query<MemberRow, [string, string]>(
        "SELECT team_id, user_id, role, state, revision FROM members WHERE team_id = ? AND user_id = ?",
      )
      .get(teamId, userId);
  const membership = (row: MemberRow): TeamMembership =>
    TeamMembershipSchema.parse({
      team_id: row.team_id,
      user_id: row.user_id,
      role: row.role,
      state: row.state,
      revision: row.revision,
    });
  const requireTeamMember = (actor: TeamActor): MemberRow => {
    const parsed = z
      .object({ team_id: idSchema, user_id: idSchema })
      .strict()
      .safeParse(actor);
    if (!parsed.success)
      throw new TeamError("forbidden", "Team membership required");
    const row = memberRow(parsed.data.team_id, parsed.data.user_id);
    if (!row || row.state !== "active")
      throw new TeamError("forbidden", "Team membership required");
    return row;
  };
  const activeTeamMember = (teamId: string, userId: string): boolean => {
    const row = memberRow(teamId, userId);
    return row !== null && row.state === "active";
  };

  const conversationRow = (conversationId: string) =>
    storeDb.conversationRow(ctx, conversationId);
  const participantRow = (conversationId: string, userId: string) =>
    storeDb.participantRow(ctx, conversationId, userId);
  const requireParticipant = (actor: TeamActor, conversationId: string) =>
    storeDb.requireParticipant(ctx, actor, conversationId);
  const saveLink = (link: TaskLink, insert: boolean) =>
    storeDb.saveLink(ctx, link, insert);
  const requireLink = (
    actor: TeamActor,
    linkId: string,
    requesterOnly: boolean,
  ) => storeDb.requireLink(ctx, actor, linkId, requesterOnly);
  const emitEvent = (
    conversation: ConversationRow,
    kind: "message" | "membership" | "reaction" | "edit",
    messageSeq: number,
    messageId: string | null,
    revision: number,
  ) =>
    storeDb.emitEvent(ctx, conversation, kind, messageSeq, messageId, revision);
  const saveConversation = (conversation: ConversationRow) =>
    storeDb.saveConversation(ctx, conversation);
  const insertMessage = (conversation: ConversationRow, record: Message) =>
    storeDb.insertMessage(ctx, conversation, record);
  const idempotent = <T>(
    actor: TeamActor,
    requestId: string,
    operation: string,
    input: unknown,
    schema: z.ZodType<T>,
    perform: () => T,
  ): T =>
    storeDb.idempotent(
      ctx,
      actor,
      requestId,
      operation,
      input,
      schema,
      perform,
    );

  const messageRecord = (row: MessageRow): Message => {
    const legacy = {
      message_id: row.message_id,
      conversation_id: row.conversation_id,
      author_id: row.author_id,
      seq: row.seq,
      client_message_id: row.client_message_id,
      body: row.body,
      body_sha256: row.body_sha256,
      reply_to: row.reply_to,
      reference_ids: JSON.parse(row.reference_ids_json) as string[],
      created_at: row.created_at,
      edited_at: row.edited_at,
      deleted: row.deleted === 1,
    };
    const record = {
      ...legacy,
      kind: row.kind,
      agent_request_id: row.agent_request_id,
    };
    // Rows written before migration 0004 were digested without `kind` and
    // `agent_request_id` (user text and result cards alike).
    const intact =
      sha256(canonicalJson(record)) === row.record_sha256 ||
      (row.agent_request_id === null &&
        sha256(canonicalJson(legacy)) === row.record_sha256);
    if (!intact)
      throw new TeamError("corrupt_record", "Stored message is invalid");
    const share = row.kind === "result_card" ? shareRow(row.message_id) : null;
    if (!share) return MessageSchema.parse(record);
    return MessageSchema.parse({ ...record, payload: shareView(share) });
  };

  const storedMessageRow = (messageId: string): MessageRow => {
    const row = db
      .query<MessageRow, [string]>(
        "SELECT * FROM messages WHERE message_id = ?",
      )
      .get(messageId);
    if (!row)
      throw new TeamError("corrupt_record", "Stored message is missing");
    return row;
  };

  const shareRow = (messageId: string): ResultShareRow | null =>
    db
      .query<ResultShareRow, [string]>(
        "SELECT * FROM result_shares WHERE message_id = ?",
      )
      .get(messageId) ?? null;

  /** Posted content never changes; staleness is overlaid from later shares of the same link. */
  const shareView = (row: ResultShareRow): ResultShare => {
    const stored = {
      share_id: row.share_id,
      link_id: row.link_id,
      message_id: row.message_id,
      message_seq: row.message_seq,
      preview_sha256: row.preview_sha256,
      candidate_diff_sha256: row.candidate_diff_sha256,
      evidence_sha256: row.evidence_sha256,
      card_json: row.card_json,
      created_at: row.created_at,
    };
    if (sha256(canonicalJson(stored)) !== row.record_sha256)
      throw new TeamError("corrupt_record", "Stored result share is invalid");
    const card = ResultCardSchema.safeParse(JSON.parse(row.card_json));
    if (!card.success)
      throw new TeamError("corrupt_record", "Stored result card is invalid");
    const newer = db
      .query<Pick<ResultShareRow, "message_id">, [string, number, string]>(
        "SELECT message_id FROM result_shares WHERE link_id = ? AND message_seq > ? AND candidate_diff_sha256 != ? ORDER BY message_seq ASC LIMIT 1",
      )
      .get(row.link_id, row.message_seq, row.candidate_diff_sha256);
    return ResultShareSchema.parse({
      ...card.data,
      share_id: row.share_id,
      message_id: row.message_id,
      preview_sha256: row.preview_sha256,
      stale: newer !== null && newer !== undefined,
      superseded_by: newer?.message_id ?? null,
      created_at: row.created_at,
    });
  };

  const repoRow = (teamId: string, repoId: string): RepoRow | null =>
    db
      .query<RepoRow, [string, string]>(
        "SELECT team_id, repo_id, label, revision FROM repos WHERE team_id = ? AND repo_id = ?",
      )
      .get(teamId, repoId);
  const repoAccessRow = (
    teamId: string,
    repoId: string,
    userId: string,
  ): RepoAccessRow | null =>
    db
      .query<RepoAccessRow, [string, string, string]>(
        "SELECT team_id, repo_id, user_id, state, revision FROM repo_access WHERE team_id = ? AND repo_id = ? AND user_id = ?",
      )
      .get(teamId, repoId, userId);
  /** Re-read on every call; the only place repo access is decided. */
  const repoAccessible = (actor: TeamActor, repoId: string): boolean => {
    if (!idSchema.safeParse(repoId).success) return false;
    if (!activeTeamMember(actor.team_id, actor.user_id)) return false;
    if (!repoRow(actor.team_id, repoId)) return false;
    const access = repoAccessRow(actor.team_id, repoId, actor.user_id);
    return access !== null && access.state === "active";
  };
  const referenceRow = (
    teamId: string,
    referenceId: string,
  ): ReferenceRow | null =>
    db
      .query<ReferenceRow, [string, string]>(
        "SELECT * FROM code_references WHERE team_id = ? AND reference_id = ?",
      )
      .get(teamId, referenceId);
  const referenceRecord = (row: ReferenceRow): GitRangeReference => {
    const record = {
      kind: "git_range" as const,
      reference_id: row.reference_id,
      team_id: row.team_id,
      repo_id: row.repo_id,
      commit_sha: row.commit_sha,
      path: row.path,
      line_start: row.line_start,
      line_end: row.line_end,
      blob_sha256: row.blob_sha256,
    };
    if (sha256(canonicalJson(record)) !== row.record_sha256)
      throw new TeamError("corrupt_record", "Stored reference is invalid");
    return GitRangeReferenceSchema.parse(record);
  };
  /** Per-viewer chips: a reference the viewer may not see is `{reference_id, restricted: true}` and nothing else. */
  const referenceChips = (
    actor: TeamActor,
    message: Message,
  ): ReferenceChip[] => {
    const references: ReferenceChip[] = message.reference_ids.map(
      (referenceId) => {
        const row = referenceRow(actor.team_id, referenceId);
        if (!row || !repoAccessible(actor, row.repo_id))
          return { reference_id: referenceId, restricted: true };
        const reference = referenceRecord(row);
        return {
          reference_id: reference.reference_id,
          restricted: false,
          repo_id: reference.repo_id,
          commit_sha: reference.commit_sha,
          path: reference.path,
          line_start: reference.line_start,
          line_end: reference.line_end,
        };
      },
    );
    return references;
  };

  const removeParticipant = (conversationId: string, userId: string) => {
    db.query(
      "UPDATE participants SET state = 'removed' WHERE conversation_id = ? AND user_id = ?",
    ).run(conversationId, userId);
    notify({
      type: "removed",
      conversation_id: conversationId,
      user_id: userId,
    });
  };
  const listeners = new Set<(notice: StoreNotice) => void>();
  let pending: StoreNotice[] | null = null;
  const notify = (notice: StoreNotice) => {
    if (pending) pending.push(notice);
  };
  const write = <T>(fn: () => T): T => {
    if (pending) return fn();
    pending = [];
    let notices: StoreNotice[];
    try {
      const result = db.transaction(fn).immediate();
      notices = pending;
      pending = null;
      for (const notice of notices)
        for (const listener of listeners) {
          try {
            listener(notice);
          } catch {
            // A failing subscriber never undoes a committed write.
          }
        }
      return result;
    } finally {
      pending = null;
    }
  };
  const read = <T>(fn: () => T): T => db.transaction(fn)();

  /**
   * Per-(window, team, user) sliding-minute budgets. In-memory and therefore
   * per serving process (the pilot runs one); the store itself stays
   * multi-process safe. A refused call carries the seconds until the oldest
   * stamp leaves the window, which the server turns into `Retry-After`.
   */
  const RATE_WINDOW_MS = 60_000;
  const windows = new Map<string, number[]>();
  const takeSlot = (
    actor: TeamActor,
    window: "send" | "reaction" | "search" | "agent",
    limit: number,
  ) => {
    const key = `${window}\u0000${actor.team_id}\u0000${actor.user_id}`;
    const at = now().getTime();
    const recent = (windows.get(key) ?? []).filter(
      (stamp) => at - stamp < RATE_WINDOW_MS,
    );
    if (recent.length >= limit) {
      windows.set(key, recent);
      const oldest = recent[0] ?? at;
      throw rateLimited(
        `${window} rate limit reached`,
        (oldest + RATE_WINDOW_MS - at) / 1000,
      );
    }
    recent.push(at);
    windows.set(key, recent);
  };
  const takeSearchSlot = (actor: TeamActor) =>
    takeSlot(actor, "search", limits.max_search_per_minute);
  const takeSendSlot = (actor: TeamActor) =>
    takeSlot(actor, "send", limits.max_sends_per_minute);
  const takeReactionSlot = (actor: TeamActor) =>
    takeSlot(actor, "reaction", limits.max_reactions_per_minute);
  const takeAgentSlot = (actor: TeamActor) =>
    takeSlot(actor, "agent", limits.max_agent_requests_per_minute);

  const reactionSummaries = (
    messageId: string,
    userId: string,
  ): ReactionSummary[] =>
    db
      .query<{ emoji: string; count: number; mine: number }, [string, string]>(
        "SELECT emoji, COUNT(*) AS count, SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS mine FROM reactions WHERE message_id = ? GROUP BY emoji ORDER BY emoji",
      )
      .all(userId, messageId)
      .map((row) => ({
        emoji: row.emoji,
        count: row.count,
        reacted: row.mine > 0,
      }));

  const messageView = (
    actor: TeamActor,
    row: MessageRow,
    participant: ParticipantRow,
  ): MessageView => {
    const message = messageRecord(row);
    let reply_excerpt: string | null = null;
    let reply_restricted = false;
    if (message.reply_to !== null) {
      const target = db
        .query<Pick<MessageRow, "seq" | "body" | "deleted">, [string, string]>(
          "SELECT seq, body, deleted FROM messages WHERE message_id = ? AND conversation_id = ?",
        )
        .get(message.reply_to, row.conversation_id);
      if (!target || target.seq <= participant.joined_seq)
        reply_restricted = true;
      else if (target.deleted !== 1)
        reply_excerpt = headExcerpt(target.body, TEAM_MAX_EXCERPT_CHARS).text;
    }
    return MessageViewSchema.parse({
      ...message,
      references: referenceChips(actor, message),
      reactions: reactionSummaries(row.message_id, participant.user_id),
      reply_excerpt,
      reply_restricted,
    });
  };

  return {
    db,
    limits,
    randomId,
    agentOptions,
    timestamp,
    metrics,
    ctx,
    readEnabled,
    memberRow,
    membership,
    requireTeamMember,
    activeTeamMember,
    conversationRow,
    participantRow,
    requireParticipant,
    saveLink,
    requireLink,
    emitEvent,
    saveConversation,
    insertMessage,
    idempotent,
    messageRecord,
    storedMessageRow,
    repoRow,
    repoAccessRow,
    repoAccessible,
    referenceRow,
    referenceRecord,
    removeParticipant,
    listeners,
    notify,
    write,
    read,
    takeSearchSlot,
    takeSendSlot,
    takeReactionSlot,
    takeAgentSlot,
    messageView,
  };
}

export type StoreScope = ReturnType<typeof createStoreScope>;
