import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import type { Message, TaskLink } from "@mars/contracts";
import { z } from "zod";
import { TeamError } from "./errors";
import { DEFAULT_TEAM_LIMITS } from "./schemas";
import { type StoreNotice, TEAM_MIGRATIONS } from "./store";
import {
  type ConversationRow,
  conversationRow,
  idempotent,
  insertMessage,
  nextCreatedSeq,
  nextMessageSeq,
  requireLink,
  requireParticipant,
  type StoreDbContext,
  saveLink,
  sha256,
} from "./store-db";

const AT = "2026-01-01T00:00:00.000Z";
const actor = { team_id: "t1", user_id: "alice" };
const dbs: Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

function context(
  maxIdempotencyRows = DEFAULT_TEAM_LIMITS.max_pending_idempotency_rows,
) {
  const db = new Database(":memory:", { strict: true });
  dbs.push(db);
  db.exec("PRAGMA foreign_keys=ON;");
  for (const migration of TEAM_MIGRATIONS) db.exec(migration.sql);
  const notices: StoreNotice[] = [];
  const counters: Record<string, number> = {};
  const ctx: StoreDbContext = {
    db,
    limits: {
      ...DEFAULT_TEAM_LIMITS,
      max_pending_idempotency_rows: maxIdempotencyRows,
    },
    clock: () => new Date(AT),
    metrics: {
      increment(name, by = 1) {
        counters[name] = (counters[name] ?? 0) + by;
      },
      snapshot: () => {
        throw new Error("unused");
      },
    },
    notify: (notice) => notices.push(notice),
  };
  return { ctx, db, notices, counters };
}

function seedConversation(ctx: StoreDbContext, members: string[]) {
  ctx.db
    .query(
      "INSERT INTO conversations (conversation_id, team_id, kind, title, dm_key, revision, last_seq, last_event_seq, created_by, created_at, updated_at) VALUES ('c1', 't1', 'group', NULL, NULL, 1, 0, 0, 'alice', ?, ?)",
    )
    .run(AT, AT);
  for (const userId of members)
    ctx.db
      .query(
        "INSERT INTO participants (conversation_id, user_id, joined_seq, joined_event_seq, state, pinned, read_seq) VALUES ('c1', ?, 0, 0, 'active', 0, 0)",
      )
      .run(userId);
  return conversationRow(ctx, "c1") as ConversationRow;
}

function message(conversation: ConversationRow, id: string): Message {
  return {
    message_id: id,
    conversation_id: conversation.conversation_id,
    author_id: "alice",
    kind: "user",
    agent_request_id: null,
    seq: nextMessageSeq(conversation),
    client_message_id: `client-${id}`,
    body: "hello",
    body_sha256: sha256("hello"),
    reply_to: null,
    reference_ids: [],
    created_at: AT,
    edited_at: null,
    deleted: false,
  };
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof TeamError) return error.code;
    throw error;
  }
  return "ok";
}

test("insertMessage advances seqs, writes the outbox and queues a notice", () => {
  const { ctx, db, notices } = context();
  const conversation = seedConversation(ctx, ["alice"]);
  insertMessage(ctx, conversation, message(conversation, "m1"));
  insertMessage(ctx, conversation, message(conversation, "m2"));
  expect(conversationRow(ctx, "c1")).toMatchObject({
    last_seq: 2,
    last_event_seq: 2,
    updated_at: AT,
  });
  expect(
    db
      .query("SELECT event_seq, kind, message_seq, message_id FROM outbox")
      .all(),
  ).toEqual([
    { event_seq: 1, kind: "message", message_seq: 1, message_id: "m1" },
    { event_seq: 2, kind: "message", message_seq: 2, message_id: "m2" },
  ]);
  expect(notices).toEqual([
    { type: "event", conversation_id: "c1" },
    { type: "event", conversation_id: "c1" },
  ]);
});

test("idempotent replays equal input, rejects changed input and prunes old rows", () => {
  const { ctx, db, counters } = context(2);
  let runs = 0;
  const perform = () => ({ n: ++runs });
  const schema = z.object({ n: z.number() });
  const send = (requestId: string, input: unknown) =>
    idempotent(ctx, actor, requestId, "messages.send", input, schema, perform);
  expect(send("r1", { a: 1 })).toEqual({ n: 1 });
  expect(send("r1", { a: 1 })).toEqual({ n: 1 });
  expect(runs).toBe(1);
  expect(counters.send_replays).toBe(1);
  expect(code(() => send("r1", { a: 2 }))).toBe("conflict");
  expect(code(() => send("", { a: 1 }))).toBe("invalid_input");
  send("r2", {});
  send("r3", {});
  expect(
    db
      .query(
        "SELECT request_id, created_seq FROM idempotency ORDER BY created_seq",
      )
      .all(),
  ).toEqual([
    { request_id: "r2", created_seq: 2 },
    { request_id: "r3", created_seq: 3 },
  ]);
  expect(nextCreatedSeq(ctx, "idempotency")).toBe(4);
  expect(nextCreatedSeq(ctx, "agent_requests")).toBe(1);
});

test("requireParticipant and requireLink answer not_found or forbidden", () => {
  const { ctx } = context();
  const conversation = seedConversation(ctx, ["alice", "bob"]);
  insertMessage(ctx, conversation, message(conversation, "m1"));
  const link: TaskLink = {
    link_id: "l1",
    team_id: "t1",
    conversation_id: "c1",
    requester_id: "alice",
    launch_key: "tc-l1",
    provenance: [{ message_id: "m1", seq: 1, body_sha256: sha256("hello") }],
    reference_ids: [],
    target: null,
    workbench: null,
    task_revision: null,
    status: "draft",
    created_at: AT,
    updated_at: AT,
  };
  saveLink(ctx, link, true);
  const bob = { team_id: "t1", user_id: "bob" };
  expect(requireLink(ctx, actor, "l1", true).link).toEqual(link);
  expect(requireLink(ctx, bob, "l1", false).link).toEqual(link);
  expect(code(() => requireLink(ctx, bob, "l1", true))).toBe("forbidden");
  expect(
    code(() => requireLink(ctx, { ...actor, team_id: "t2" }, "l1", false)),
  ).toBe("not_found");
  expect(code(() => requireLink(ctx, actor, "missing", false))).toBe(
    "not_found",
  );
  expect(
    code(() =>
      requireParticipant(ctx, { team_id: "t1", user_id: "carol" }, "c1"),
    ),
  ).toBe("not_found");
  saveLink(ctx, { ...link, status: "confirmed", updated_at: AT }, false);
  expect(requireLink(ctx, actor, "l1", true).link.status).toBe("confirmed");
});
