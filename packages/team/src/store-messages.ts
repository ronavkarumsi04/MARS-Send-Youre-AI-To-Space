import {
  type Message,
  MessageSchema,
  type MessageView,
  TEAM_MAX_EMOJI_CHARS,
  TEAM_MAX_EXCERPT_CHARS,
  TEAM_MAX_SEARCH_QUERY_CHARS,
  type TeamDeliveryEvent,
  TeamDeliveryEventSchema,
} from "@mars/contracts";
import { z } from "zod";
import {
  conflict,
  invalidInput,
  notFound,
  referenceNotFound,
  TeamError,
} from "./errors";
import type { TeamActor, TeamStore } from "./store";
import * as storeDb from "./store-db";
import {
  type ConversationRow,
  canonicalJson,
  idSchema,
  type MessageRow,
  type ParticipantRow,
  sha256,
} from "./store-db";
import { ENVELOPE_BYTES, type StoreScope } from "./store-scope";
import {
  excerptAround,
  hasInvisibleCodePoint,
  isValidEmoji,
  likePattern,
} from "./text";

interface OutboxRow {
  conversation_id: string;
  event_seq: number;
  kind: string;
  message_seq: number;
  message_id: string | null;
  revision: number;
}

/** `messages.*`: send, edit, delete, history, poll, reactions and search. */
export function messageOperations(
  scope: StoreScope,
): Pick<
  TeamStore,
  | "send"
  | "editMessage"
  | "deleteMessage"
  | "history"
  | "poll"
  | "setReaction"
  | "search"
> {
  const {
    db,
    limits,
    randomId,
    timestamp,
    metrics,
    requireTeamMember,
    participantRow,
    requireParticipant,
    emitEvent,
    saveConversation,
    insertMessage,
    idempotent,
    messageRecord,
    storedMessageRow,
    repoAccessible,
    referenceRow,
    write,
    read,
    takeSearchSlot,
    takeSendSlot,
    takeReactionSlot,
    messageView,
  } = scope;
  const saveMessageBody = (
    row: MessageRow,
    body: string,
    deleted: boolean,
  ): Message => {
    const record: Message = {
      ...messageRecord(row),
      body,
      body_sha256: sha256(body),
      edited_at: timestamp(),
      deleted,
    };
    db.query(
      "UPDATE messages SET body = ?, body_sha256 = ?, edited_at = ?, deleted = ?, record_sha256 = ? WHERE message_id = ?",
    ).run(
      record.body,
      record.body_sha256,
      record.edited_at,
      deleted ? 1 : 0,
      sha256(canonicalJson(record)),
      record.message_id,
    );
    return MessageSchema.parse(record);
  };
  /** Author-only lookup for edits; absent and not-yours answer alike. */
  const requireOwnMessage = (
    actor: TeamActor,
    messageId: string,
  ): { conversation: ConversationRow; row: MessageRow } => {
    if (!idSchema.safeParse(messageId).success) throw notFound();
    const row = db
      .query<MessageRow, [string]>(
        "SELECT * FROM messages WHERE message_id = ?",
      )
      .get(messageId);
    if (!row || row.author_id !== actor.user_id) throw notFound();
    const { conversation } = requireParticipant(actor, row.conversation_id);
    if (row.kind !== "user")
      throw invalidInput("Agent messages cannot be edited");
    return { conversation, row };
  };

  const messagePage = (
    actor: TeamActor,
    participant: ParticipantRow,
    rows: MessageRow[],
    fromCursorSide: boolean,
  ): MessageView[] => {
    const page: MessageView[] = [];
    let bytes = ENVELOPE_BYTES;
    for (const row of rows) {
      const message = messageView(actor, row, participant);
      const size =
        Buffer.byteLength(JSON.stringify(message)) + (page.length ? 1 : 0);
      if (bytes + size > limits.max_page_bytes) {
        if (page.length === 0)
          throw new TeamError(
            "too_large",
            "A single message exceeds the page size",
          );
        break;
      }
      page.push(message);
      bytes += size;
    }
    return fromCursorSide ? page.reverse() : page;
  };

  return {
    send(actor, requestId, input) {
      return write(() => {
        requireTeamMember(actor);
        takeSendSlot(actor);
        // Before any idempotent replay: a participant removed since the
        // original send must not read the stored message back.
        requireParticipant(actor, input.conversation_id);
        const stored = idempotent(
          actor,
          requestId,
          "messages.send",
          input,
          MessageSchema,
          () => {
            const { conversation, participant } = requireParticipant(
              actor,
              input.conversation_id,
            );
            const parsed = z
              .object({
                conversation_id: idSchema,
                client_message_id: z
                  .string()
                  .min(1)
                  .max(limits.max_client_message_id_chars),
                body: z.string().min(1),
                reply_to: idSchema.optional(),
                reference_ids: z
                  .array(idSchema)
                  .max(limits.max_references_per_message)
                  .optional(),
              })
              .strict()
              .safeParse(input);
            if (!parsed.success) throw invalidInput("Invalid message input");
            const referenceIds = parsed.data.reference_ids ?? [];
            if (new Set(referenceIds).size !== referenceIds.length)
              throw invalidInput("Duplicate reference id");
            // Each reference must exist in this team and the sender must have
            // access to its repo now; absent and inaccessible look alike.
            for (const referenceId of referenceIds) {
              const row = referenceRow(actor.team_id, referenceId);
              if (!row || !repoAccessible(actor, row.repo_id))
                throw referenceNotFound();
            }
            if (Buffer.byteLength(parsed.data.body) > limits.max_body_bytes)
              throw new TeamError(
                "too_large",
                "Message body exceeds the size limit",
              );
            const bodyHash = sha256(parsed.data.body);
            const previous = db
              .query<MessageRow, [string, string, string]>(
                "SELECT * FROM messages WHERE conversation_id = ? AND author_id = ? AND client_message_id = ?",
              )
              .get(
                conversation.conversation_id,
                actor.user_id,
                parsed.data.client_message_id,
              );
            if (previous) {
              if (
                previous.body_sha256 !== bodyHash ||
                previous.reference_ids_json !== JSON.stringify(referenceIds)
              )
                throw conflict(
                  "client_message_id was reused with a different body",
                );
              metrics.increment("send_replays");
              return messageRecord(previous);
            }
            if (parsed.data.reply_to !== undefined) {
              const target = db
                .query<Pick<MessageRow, "seq">, [string, string]>(
                  "SELECT seq FROM messages WHERE message_id = ? AND conversation_id = ?",
                )
                .get(parsed.data.reply_to, conversation.conversation_id);
              if (!target || target.seq <= participant.joined_seq)
                throw invalidInput("Reply target is not in this conversation");
            }
            metrics.increment("sends");
            return insertMessage(conversation, {
              message_id: randomId(),
              conversation_id: conversation.conversation_id,
              author_id: actor.user_id,
              kind: "user",
              agent_request_id: null,
              seq: storeDb.nextMessageSeq(conversation),
              client_message_id: parsed.data.client_message_id,
              body: parsed.data.body,
              body_sha256: bodyHash,
              reply_to: parsed.data.reply_to ?? null,
              reference_ids: referenceIds,
              created_at: timestamp(),
              edited_at: null,
              deleted: false,
            });
          },
        );
        // Chips are derived now, never stored: a replay after a revocation
        // shows the sender's own reference as restricted.
        const viewed = stored;
        const viewer = participantRow(viewed.conversation_id, actor.user_id);
        if (!viewer) throw notFound();
        // A replay (same request_id or client_message_id) of a message sent
        // before the caller's current join window would reveal that body.
        if (viewed.seq <= viewer.joined_seq)
          throw conflict("client_message_id predates the current membership");
        return messageView(actor, storedMessageRow(viewed.message_id), viewer);
      });
    },
    editMessage(actor, input) {
      return write(() => {
        requireTeamMember(actor);
        takeSendSlot(actor);
        const parsed = z
          .object({ message_id: idSchema, body: z.string().min(1) })
          .strict()
          .safeParse(input);
        if (!parsed.success) throw invalidInput("Invalid edit input");
        if (Buffer.byteLength(parsed.data.body) > limits.max_body_bytes)
          throw new TeamError(
            "too_large",
            "Message body exceeds the size limit",
          );
        const { conversation, row } = requireOwnMessage(
          actor,
          parsed.data.message_id,
        );
        if (row.deleted === 1)
          throw invalidInput("Deleted messages cannot be edited");
        const message = saveMessageBody(row, parsed.data.body, false);
        emitEvent(
          conversation,
          "edit",
          message.seq,
          message.message_id,
          conversation.revision,
        );
        saveConversation(conversation);
        return messageView(
          actor,
          storedMessageRow(message.message_id),
          requireParticipant(actor, conversation.conversation_id).participant,
        );
      });
    },
    deleteMessage(actor, input) {
      return write(() => {
        requireTeamMember(actor);
        takeSendSlot(actor);
        const parsed = z
          .object({ message_id: idSchema })
          .strict()
          .safeParse(input);
        if (!parsed.success) throw invalidInput("Invalid delete input");
        const { conversation, row } = requireOwnMessage(
          actor,
          parsed.data.message_id,
        );
        if (row.deleted === 1)
          return messageView(
            actor,
            row,
            requireParticipant(actor, conversation.conversation_id).participant,
          );
        const message = saveMessageBody(row, "", true);
        emitEvent(
          conversation,
          "edit",
          message.seq,
          message.message_id,
          conversation.revision,
        );
        saveConversation(conversation);
        return messageView(
          actor,
          storedMessageRow(message.message_id),
          requireParticipant(actor, conversation.conversation_id).participant,
        );
      });
    },
    history(actor, query) {
      return read(() => {
        requireTeamMember(actor);
        const { conversation, participant } = requireParticipant(
          actor,
          query.conversation_id,
        );
        const limit = query.limit ?? limits.page_limit;
        if (!Number.isInteger(limit) || limit < 1 || limit > limits.page_limit)
          throw invalidInput("Invalid page limit");
        if (query.after_seq !== undefined && query.before_seq !== undefined)
          throw invalidInput("Use either after_seq or before_seq");
        const floor = participant.joined_seq;
        if (query.after_seq !== undefined) {
          if (
            !Number.isInteger(query.after_seq) ||
            query.after_seq < 0 ||
            query.after_seq > conversation.last_seq
          )
            throw new TeamError("unknown_cursor", "Unknown history cursor");
          const rows = db
            .query<MessageRow, [string, number, number, number]>(
              "SELECT * FROM messages WHERE conversation_id = ? AND seq > ? AND seq > ? ORDER BY seq ASC LIMIT ?",
            )
            .all(conversation.conversation_id, query.after_seq, floor, limit);
          return messagePage(actor, participant, rows, false);
        }
        const before = query.before_seq ?? conversation.last_seq + 1;
        if (
          !Number.isInteger(before) ||
          before < 1 ||
          before > conversation.last_seq + 1
        )
          throw new TeamError("unknown_cursor", "Unknown history cursor");
        const rows = db
          .query<MessageRow, [string, number, number, number]>(
            "SELECT * FROM messages WHERE conversation_id = ? AND seq < ? AND seq > ? ORDER BY seq DESC LIMIT ?",
          )
          .all(conversation.conversation_id, before, floor, limit);
        return messagePage(actor, participant, rows, true);
      });
    },
    poll(actor, input) {
      return read(() => {
        requireTeamMember(actor);
        const limit = input.limit ?? limits.max_poll_events;
        if (
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > limits.max_poll_events
        )
          throw invalidInput("Invalid poll limit");
        if (
          !Array.isArray(input.cursors) ||
          input.cursors.length > limits.max_cursors_per_poll
        )
          throw invalidInput("Too many cursors");
        // Every cursor is authorized and bounds-checked before any row is
        // read, so a full page can never hide an invalid later cursor.
        const seen = new Set<string>();
        const checked: {
          conversation: ConversationRow;
          participant: ParticipantRow;
          after: number;
        }[] = [];
        for (const cursor of input.cursors) {
          if (seen.has(cursor.conversation_id))
            throw invalidInput("Duplicate cursor");
          seen.add(cursor.conversation_id);
          const { conversation, participant } = requireParticipant(
            actor,
            cursor.conversation_id,
          );
          if (
            !Number.isInteger(cursor.after_event_seq) ||
            cursor.after_event_seq < 0 ||
            cursor.after_event_seq > conversation.last_event_seq
          )
            throw new TeamError("unknown_cursor", "Unknown event cursor");
          checked.push({
            conversation,
            participant,
            after: cursor.after_event_seq,
          });
        }
        const events: TeamDeliveryEvent[] = [];
        for (const { conversation, participant, after } of checked) {
          const remaining = limit - events.length;
          if (remaining <= 0) break;
          const rows = db
            .query<OutboxRow, [string, number, number, number]>(
              "SELECT conversation_id, event_seq, kind, message_seq, message_id, revision FROM outbox WHERE conversation_id = ? AND event_seq > ? AND event_seq > ? ORDER BY event_seq ASC LIMIT ?",
            )
            .all(
              conversation.conversation_id,
              after,
              participant.joined_event_seq,
              remaining,
            );
          for (const row of rows)
            events.push(
              TeamDeliveryEventSchema.parse({
                conversation_id: row.conversation_id,
                event_seq: row.event_seq,
                kind: row.kind,
                message_seq: row.message_seq,
                message_id: row.message_id,
                revision: row.revision,
              }),
            );
        }
        return events;
      });
    },
    setReaction(actor, input) {
      return write(() => {
        requireTeamMember(actor);
        takeReactionSlot(actor);
        if (typeof input.on !== "boolean")
          throw invalidInput("on must be boolean");
        if (!isValidEmoji(input.emoji, TEAM_MAX_EMOJI_CHARS))
          throw invalidInput("Invalid reaction key");
        if (!idSchema.safeParse(input.message_id).success) throw notFound();
        const message = db
          .query<
            Pick<MessageRow, "message_id" | "conversation_id" | "seq">,
            [string]
          >(
            "SELECT message_id, conversation_id, seq FROM messages WHERE message_id = ?",
          )
          .get(input.message_id);
        if (!message) throw notFound();
        const { conversation, participant } = requireParticipant(
          actor,
          message.conversation_id,
        );
        if (message.seq <= participant.joined_seq) throw notFound();
        const existing = db
          .query<{ user_id: string }, [string, string, string]>(
            "SELECT user_id FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?",
          )
          .get(message.message_id, actor.user_id, input.emoji);
        let changed = false;
        if (input.on && !existing) {
          const distinct =
            db
              .query<{ count: number }, [string, string]>(
                "SELECT COUNT(*) AS count FROM (SELECT DISTINCT emoji FROM reactions WHERE message_id = ? AND emoji != ?)",
              )
              .get(message.message_id, input.emoji)?.count ?? 0;
          if (distinct + 1 > limits.max_reactions_per_message)
            throw new TeamError(
              "too_large",
              "Reaction key limit reached for this message",
            );
          db.query(
            "INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)",
          ).run(message.message_id, actor.user_id, input.emoji, timestamp());
          changed = true;
        } else if (!input.on && existing) {
          db.query(
            "DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?",
          ).run(message.message_id, actor.user_id, input.emoji);
          changed = true;
        }
        if (changed) {
          emitEvent(
            conversation,
            "reaction",
            message.seq,
            message.message_id,
            conversation.revision,
          );
          saveConversation(conversation);
        }
        const count =
          db
            .query<{ count: number }, [string, string]>(
              "SELECT COUNT(*) AS count FROM reactions WHERE message_id = ? AND emoji = ?",
            )
            .get(message.message_id, input.emoji)?.count ?? 0;
        return {
          message_id: message.message_id,
          emoji: input.emoji,
          count,
          reacted: input.on,
        };
      });
    },
    search(actor, query) {
      return read(() => {
        requireTeamMember(actor);
        const parsed = z
          .object({
            query: z.string().min(2).max(TEAM_MAX_SEARCH_QUERY_CHARS),
            conversation_id: idSchema.optional(),
            limit: z.number().int().positive().max(50).optional(),
            cursor: z.string().min(1).max(512).optional(),
          })
          .strict()
          .safeParse(query);
        if (!parsed.success || parsed.data.query.trim().length < 2)
          throw invalidInput("Invalid search input");
        if (hasInvisibleCodePoint(parsed.data.query))
          throw invalidInput("Invalid search input");
        takeSearchSlot(actor);
        const limit = parsed.data.limit ?? 20;
        const conversationId = parsed.data.conversation_id ?? null;
        if (conversationId !== null) requireParticipant(actor, conversationId);
        const cursorKey = sha256(
          canonicalJson([
            actor.team_id,
            actor.user_id,
            parsed.data.query,
            conversationId,
          ]),
        ).slice(0, 32);
        let after: { created_at: string; message_id: string } | null = null;
        if (parsed.data.cursor !== undefined) {
          try {
            const raw = Buffer.from(parsed.data.cursor, "base64url").toString(
              "utf8",
            );
            if (Buffer.from(raw).toString("base64url") !== parsed.data.cursor)
              throw new Error("cursor does not round-trip");
            const decoded = z
              .object({
                k: z.literal(cursorKey),
                t: z.string().datetime({ offset: true }),
                m: idSchema,
              })
              .strict()
              .parse(JSON.parse(raw));
            after = { created_at: decoded.t, message_id: decoded.m };
          } catch {
            throw new TeamError("unknown_cursor", "Unknown search cursor");
          }
        }
        // Membership is applied in SQL before any body is read: active
        // participation in the caller's team and seq inside the joined window.
        const rows = db
          .query<
            MessageRow,
            [
              string,
              string,
              string,
              string | null,
              string | null,
              string | null,
              string | null,
              string | null,
              string | null,
              number,
            ]
          >(
            `SELECT m.* FROM messages m
               JOIN participants p ON p.conversation_id = m.conversation_id AND p.user_id = ? AND p.state = 'active'
               JOIN conversations c ON c.conversation_id = m.conversation_id AND c.team_id = ?
             WHERE m.seq > p.joined_seq AND m.deleted = 0 AND m.body LIKE ? ESCAPE '\\'
               AND (? IS NULL OR m.conversation_id = ?)
               AND (? IS NULL OR m.created_at < ? OR (m.created_at = ? AND m.message_id < ?))
             ORDER BY m.created_at DESC, m.message_id DESC LIMIT ?`,
          )
          .all(
            actor.user_id,
            actor.team_id,
            likePattern(parsed.data.query),
            conversationId,
            conversationId,
            after?.created_at ?? null,
            after?.created_at ?? null,
            after?.created_at ?? null,
            after?.message_id ?? null,
            limit + 1,
          );
        const page = rows.slice(0, limit);
        const hits = page.map((row) => {
          const message = messageRecord(row);
          const excerpt = excerptAround(
            message.body,
            parsed.data.query,
            TEAM_MAX_EXCERPT_CHARS,
          );
          return {
            conversation_id: message.conversation_id,
            message_id: message.message_id,
            seq: message.seq,
            author_id: message.author_id,
            created_at: message.created_at,
            excerpt: excerpt.text,
            cut_before: excerpt.cut_before,
            cut_after: excerpt.cut_after,
          };
        });
        const tail = page[page.length - 1];
        const next_cursor =
          rows.length > limit && tail
            ? Buffer.from(
                JSON.stringify({
                  k: cursorKey,
                  t: tail.created_at,
                  m: tail.message_id,
                }),
              ).toString("base64url")
            : null;
        return { hits, next_cursor };
      });
    },
  };
}
