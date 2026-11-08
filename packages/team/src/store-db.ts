import type { Database } from "bun:sqlite";
import {
  type Message,
  MessageSchema,
  type TaskLink,
  TaskLinkSchema,
} from "@mars/contracts";
import {
  sha256,
  canonicalJson as sharedCanonicalJson,
} from "@mars/contracts/canonical";
import { z } from "zod";
import { conflict, invalidInput, notFound, TeamError } from "./errors";
import type { TeamMetrics } from "./metrics";
import type { TeamLimits } from "./schemas";
import type { StoreNotice, TeamActor } from "./store";

/**
 * Row-level persistence for the team store: row reads and writes, sequence
 * allocation and idempotent replay. Callers own authorization policy and the
 * transaction boundary (`write`); these helpers never open a transaction.
 */
export interface StoreDbContext {
  readonly db: Database;
  readonly limits: TeamLimits;
  readonly clock: () => Date;
  readonly metrics: TeamMetrics;
  /** Queues a post-commit notice for subscribers. */
  readonly notify: (notice: StoreNotice) => void;
}

export const idSchema = z.string().min(1).max(256);

export { sha256 };

export function canonicalJson(value: unknown): string {
  return sharedCanonicalJson(value, {
    error: () => invalidInput("Value is not JSON data"),
  });
}

export interface ConversationRow {
  conversation_id: string;
  team_id: string;
  kind: string;
  title: string | null;
  dm_key: string | null;
  revision: number;
  last_seq: number;
  last_event_seq: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}
export interface ParticipantRow {
  conversation_id: string;
  user_id: string;
  joined_seq: number;
  joined_event_seq: number;
  state: string;
  pinned: number;
  read_seq: number;
}
export interface MessageRow {
  message_id: string;
  conversation_id: string;
  seq: number;
  author_id: string;
  client_message_id: string;
  body: string;
  body_sha256: string;
  reply_to: string | null;
  reference_ids_json: string;
  created_at: string;
  edited_at: string | null;
  deleted: number;
  record_sha256: string;
  kind: string;
  agent_request_id: string | null;
}
export interface TaskLinkRow {
  link_id: string;
  team_id: string;
  conversation_id: string;
  requester_id: string;
  launch_key: string;
  provenance_json: string;
  reference_ids_json: string;
  target_json: string | null;
  workbench_json: string | null;
  task_revision: number | null;
  status: string;
  created_at: string;
  updated_at: string;
  record_sha256: string;
}

export const timestamp = (ctx: StoreDbContext): string =>
  ctx.clock().toISOString();

/** Seq the next message posted to the conversation takes. */
export const nextMessageSeq = (conversation: ConversationRow): number =>
  conversation.last_seq + 1;

/** Next insertion-order value for a table with a `created_seq` column. */
export const nextCreatedSeq = (
  ctx: StoreDbContext,
  table: "idempotency" | "agent_requests",
): number =>
  (ctx.db
    .query<{ max: number | null }, []>(
      `SELECT MAX(created_seq) AS max FROM ${table}`,
    )
    .get()?.max ?? 0) + 1;

export const conversationRow = (
  ctx: StoreDbContext,
  conversationId: string,
): ConversationRow | null =>
  ctx.db
    .query<ConversationRow, [string]>(
      "SELECT * FROM conversations WHERE conversation_id = ?",
    )
    .get(conversationId);

export const participantRow = (
  ctx: StoreDbContext,
  conversationId: string,
  userId: string,
): ParticipantRow | null =>
  ctx.db
    .query<ParticipantRow, [string, string]>(
      "SELECT * FROM participants WHERE conversation_id = ? AND user_id = ?",
    )
    .get(conversationId, userId);

/** Conversation in the actor's team with the actor as an active participant; one code for absent and not-yours. */
export const requireParticipant = (
  ctx: StoreDbContext,
  actor: TeamActor,
  conversationId: string,
): { conversation: ConversationRow; participant: ParticipantRow } => {
  if (!idSchema.safeParse(conversationId).success) throw notFound();
  const conversation = conversationRow(ctx, conversationId);
  if (!conversation || conversation.team_id !== actor.team_id) throw notFound();
  const participant = participantRow(ctx, conversationId, actor.user_id);
  if (!participant || participant.state !== "active") throw notFound();
  return { conversation, participant };
};

export const linkRow = (
  ctx: StoreDbContext,
  linkId: string,
): TaskLinkRow | null =>
  idSchema.safeParse(linkId).success
    ? (ctx.db
        .query<TaskLinkRow, [string]>(
          "SELECT * FROM task_links WHERE link_id = ?",
        )
        .get(linkId) ?? null)
    : null;

export const linkRecord = (row: TaskLinkRow): TaskLink => {
  const record = {
    link_id: row.link_id,
    team_id: row.team_id,
    conversation_id: row.conversation_id,
    requester_id: row.requester_id,
    launch_key: row.launch_key,
    provenance: JSON.parse(row.provenance_json) as unknown,
    reference_ids: JSON.parse(row.reference_ids_json) as unknown,
    target:
      row.target_json === null
        ? null
        : (JSON.parse(row.target_json) as unknown),
    workbench:
      row.workbench_json === null
        ? null
        : (JSON.parse(row.workbench_json) as unknown),
    task_revision: row.task_revision,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (sha256(canonicalJson(record)) !== row.record_sha256)
    throw new TeamError("corrupt_record", "Stored task link is invalid");
  return TaskLinkSchema.parse(record);
};

export const saveLink = (
  ctx: StoreDbContext,
  link: TaskLink,
  insert: boolean,
) => {
  const recordHash = sha256(canonicalJson(link));
  if (insert)
    ctx.db
      .query(
        "INSERT INTO task_links (link_id, team_id, conversation_id, requester_id, launch_key, provenance_json, reference_ids_json, target_json, workbench_json, task_revision, status, created_at, updated_at, record_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        link.link_id,
        link.team_id,
        link.conversation_id,
        link.requester_id,
        link.launch_key,
        canonicalJson(link.provenance),
        canonicalJson(link.reference_ids),
        link.target === null ? null : canonicalJson(link.target),
        link.workbench === null ? null : canonicalJson(link.workbench),
        link.task_revision,
        link.status,
        link.created_at,
        link.updated_at,
        recordHash,
      );
  else
    ctx.db
      .query(
        "UPDATE task_links SET target_json = ?, workbench_json = ?, task_revision = ?, status = ?, updated_at = ?, record_sha256 = ? WHERE link_id = ?",
      )
      .run(
        link.target === null ? null : canonicalJson(link.target),
        link.workbench === null ? null : canonicalJson(link.workbench),
        link.task_revision,
        link.status,
        link.updated_at,
        recordHash,
        link.link_id,
      );
};

/**
 * Resolves a link for the actor: absent, foreign-team and non-participant
 * cases all answer the same `not_found`; `requesterOnly` rejects other
 * members with `forbidden` (they may inspect, never act).
 */
export const requireLink = (
  ctx: StoreDbContext,
  actor: TeamActor,
  linkId: string,
  requesterOnly: boolean,
): {
  link: TaskLink;
  conversation: ConversationRow;
  participant: ParticipantRow;
} => {
  const row = linkRow(ctx, linkId);
  if (!row || row.team_id !== actor.team_id) throw notFound();
  const { conversation, participant } = requireParticipant(
    ctx,
    actor,
    row.conversation_id,
  );
  const link = linkRecord(row);
  if (link.requester_id !== actor.user_id) {
    // A member who joined (or rejoined) after the quoted messages cannot read
    // them through history, so the link stays invisible to them as well.
    if (link.provenance.some((entry) => entry.seq <= participant.joined_seq))
      throw notFound();
    if (requesterOnly)
      throw new TeamError("forbidden", "Only the requester may act on a link");
  }
  return { link, conversation, participant };
};

export const emitEvent = (
  ctx: StoreDbContext,
  conversation: ConversationRow,
  kind: "message" | "membership" | "reaction" | "edit",
  messageSeq: number,
  messageId: string | null,
  revision: number,
): number => {
  const eventSeq = conversation.last_event_seq + 1;
  ctx.db
    .query(
      "INSERT INTO outbox (conversation_id, event_seq, kind, message_seq, message_id, revision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      conversation.conversation_id,
      eventSeq,
      kind,
      messageSeq,
      messageId,
      revision,
      timestamp(ctx),
    );
  conversation.last_event_seq = eventSeq;
  ctx.notify({ type: "event", conversation_id: conversation.conversation_id });
  return eventSeq;
};

export const saveConversation = (
  ctx: StoreDbContext,
  conversation: ConversationRow,
) => {
  ctx.db
    .query(
      "UPDATE conversations SET title = ?, revision = ?, last_seq = ?, last_event_seq = ?, updated_at = ? WHERE conversation_id = ?",
    )
    .run(
      conversation.title,
      conversation.revision,
      conversation.last_seq,
      conversation.last_event_seq,
      timestamp(ctx),
      conversation.conversation_id,
    );
};

export const insertMessage = (
  ctx: StoreDbContext,
  conversation: ConversationRow,
  record: Message,
): Message => {
  ctx.db
    .query(
      "INSERT INTO messages (message_id, conversation_id, seq, author_id, client_message_id, body, body_sha256, reply_to, reference_ids_json, created_at, edited_at, deleted, record_sha256, kind, agent_request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?)",
    )
    .run(
      record.message_id,
      record.conversation_id,
      record.seq,
      record.author_id,
      record.client_message_id,
      record.body,
      record.body_sha256,
      record.reply_to,
      JSON.stringify(record.reference_ids),
      record.created_at,
      sha256(canonicalJson(record)),
      record.kind,
      record.agent_request_id,
    );
  // Chips join through message_references; ids outside code_references
  // (agent citations supplied by the host port) render as restricted chips.
  record.reference_ids.forEach((referenceId, position) => {
    ctx.db
      .query(
        "INSERT INTO message_references (message_id, team_id, reference_id, position) SELECT ?, team_id, reference_id, ? FROM code_references WHERE team_id = ? AND reference_id = ?",
      )
      .run(record.message_id, position, conversation.team_id, referenceId);
  });
  conversation.last_seq = record.seq;
  emitEvent(
    ctx,
    conversation,
    "message",
    record.seq,
    record.message_id,
    conversation.revision,
  );
  saveConversation(ctx, conversation);
  return MessageSchema.parse(record);
};

/**
 * Idempotency results stored before migration 0004 lack `agent_request_id`
 * (and, for plain sends, `kind`) on messages; replays add the values those
 * rows had.
 */
function upgradeLegacyResult(operation: string, raw: unknown): unknown {
  if (
    (operation === "messages.send" || operation === "shares.create") &&
    raw !== null &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    !("agent_request_id" in raw)
  ) {
    // Pre-0004 cards already carried `kind: "result_card"`; plain sends had no kind.
    const legacy = raw as { kind?: unknown };
    return {
      ...raw,
      kind:
        legacy.kind ?? (operation === "shares.create" ? "result_card" : "user"),
      agent_request_id: null,
    };
  }
  return raw;
}

// Idempotency: (team, user, request, operation, input digest) → stored result.
// Equal digest replays; a reused request id with another input is a conflict.
export const idempotent = <T>(
  ctx: StoreDbContext,
  actor: TeamActor,
  requestId: string,
  operation: string,
  input: unknown,
  schema: z.ZodType<T>,
  perform: () => T,
): T => {
  if (!idSchema.safeParse(requestId).success)
    throw invalidInput("request_id is required");
  const inputHash = sha256(canonicalJson(input));
  const previous = ctx.db
    .query<
      { input_sha256: string; result_json: string },
      [string, string, string, string]
    >(
      "SELECT input_sha256, result_json FROM idempotency WHERE team_id = ? AND user_id = ? AND request_id = ? AND operation = ?",
    )
    .all(actor.team_id, actor.user_id, requestId, operation);
  const match = previous.find((row) => row.input_sha256 === inputHash);
  if (match) {
    if (operation === "messages.send") ctx.metrics.increment("send_replays");
    try {
      return schema.parse(
        upgradeLegacyResult(operation, JSON.parse(match.result_json)),
      );
    } catch {
      throw new TeamError("corrupt_record", "Corrupt idempotency result");
    }
  }
  if (previous.length > 0)
    throw conflict("Request id was reused with different input");
  const result = perform();
  const createdSeq = nextCreatedSeq(ctx, "idempotency");
  ctx.db
    .query(
      "INSERT INTO idempotency (team_id, user_id, request_id, operation, input_sha256, result_json, created_seq) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      actor.team_id,
      actor.user_id,
      requestId,
      operation,
      inputHash,
      canonicalJson(result),
      createdSeq,
    );
  const count =
    ctx.db
      .query<{ count: number }, [string, string]>(
        "SELECT COUNT(*) AS count FROM idempotency WHERE team_id = ? AND user_id = ?",
      )
      .get(actor.team_id, actor.user_id)?.count ?? 0;
  if (count > ctx.limits.max_pending_idempotency_rows)
    ctx.db
      .query(
        "DELETE FROM idempotency WHERE rowid IN (SELECT rowid FROM idempotency WHERE team_id = ? AND user_id = ? ORDER BY created_seq LIMIT ?)",
      )
      .run(
        actor.team_id,
        actor.user_id,
        count - ctx.limits.max_pending_idempotency_rows,
      );
  return result;
};
