import {
  type Message,
  type ResultCard,
  type SharedEvidence,
  type Task,
  type TaskLink,
  TaskLinkWorkbenchSchema,
} from "@mars/contracts";
import { RpcError, type RpcRequest } from "../src/rpc";
import type { TeamTransport } from "../src/teamChat/client";
import type {
  TaskLinkDraftResult,
  TeamContext,
  TeamEvent,
  TeamRpcMethod,
} from "../src/teamChat/protocol";

/**
 * In-memory stand-in for `@mars/team` behind the client's transport
 * interface (pattern: `test/fixtures.ts` `FakeServer`). It speaks the exact
 * RPC envelope, result shapes and error vocabulary of `packages/team/src/
 * server.ts` on `main` (PR 2 + PR 3 service half + PR 4); `capabilities`
 * flags decide whether `reactions.set`/`messages.search` answer or reject. Identity comes from
 * the transport the test created, never from request fields.
 */
export const TEAM_ID = "team_fixture";
export const FAKE_TEAM_TOKEN = "fake-team-token-0123456789abcdef";

interface Conversation {
  conversation_id: string;
  team_id: string;
  kind: "dm" | "group";
  title: string | null;
  dm_key: string | null;
  revision: number;
  last_seq: number;
  last_event_seq: number;
}

interface Participant {
  conversation_id: string;
  user_id: string;
  joined_seq: number;
  joined_event_seq: number;
  state: "active" | "removed";
  pinned: boolean;
  read_seq: number;
}

export interface FakeTeamOptions {
  capabilities?: {
    stream: boolean;
    reactions: boolean;
    search: boolean;
    agent?: boolean;
    links?: boolean;
    shares?: boolean;
  };
  /** Advertised and enforced `limits.page_limit` (default 200). */
  pageLimit?: number;
}

export class FakeTeamServer {
  readonly calls: RpcRequest<TeamRpcMethod, TeamContext>[] = [];
  readonly conversations = new Map<string, Conversation>();
  readonly participants: Participant[] = [];
  readonly messages: Message[] = [];
  readonly outbox: TeamEvent[] = [];
  readonly reactions: { message_id: string; user_id: string; emoji: string }[] =
    [];
  readonly members = new Set<string>();
  readonly links = new Map<string, TaskLink>();
  private readonly sharePreviews = new Map<
    string,
    { fingerprint: string; digest: string }
  >();
  /** Per-viewer chips the PR 4 server would return for a reference id (default: restricted). */
  readonly chips = new Map<
    string,
    {
      reference_id: string;
      restricted: false;
      repo_id: string;
      commit_sha: string;
      path: string;
      line_start: number | null;
      line_end: number | null;
    }
  >();
  readonly capabilities: NonNullable<FakeTeamOptions["capabilities"]>;
  readonly pageLimit: number;
  /** When true, `messages.send` commits but the acknowledgement is lost (transport error). */
  dropNextAck = false;
  /** When true, every call fails as unavailable (server down). */
  offline = false;
  /** PR 7 kill switch: every method but `team.describe` answers 503 `unavailable`; describe reports `enabled: false`. */
  disabled = false;
  /** When true, the next history page is cut to one row (the server's byte budget). */
  shortPageOnce = false;
  historyFailuresRemaining = 0;
  private counter = 0;
  private clock = 0;

  constructor(options: FakeTeamOptions = {}) {
    this.capabilities = options.capabilities ?? {
      stream: false,
      reactions: false,
      search: false,
    };
    this.pageLimit = options.pageLimit ?? 200;
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${String(this.counter).padStart(4, "0")}`;
  }

  private now(): string {
    this.clock += 1;
    return new Date(Date.UTC(2026, 0, 1, 0, 0, this.clock)).toISOString();
  }

  conversationIds(): string[] {
    return [...this.conversations.keys()];
  }

  seedDm(a: string, b: string, bodies: string[] = []): string {
    const id = this.nextId("conv_dm");
    this.conversations.set(id, {
      conversation_id: id,
      team_id: TEAM_ID,
      kind: "dm",
      title: null,
      dm_key: fakeSha256([a, b].sort().join("\n")),
      revision: 1,
      last_seq: 0,
      last_event_seq: 0,
    });
    for (const user of [a, b]) this.join(id, user);
    bodies.forEach((body, i) => {
      this.post(i % 2 === 0 ? b : a, id, body);
    });
    return id;
  }

  seedGroup(title: string, users: string[], bodies: string[] = []): string {
    const id = this.nextId("conv_grp");
    this.conversations.set(id, {
      conversation_id: id,
      team_id: TEAM_ID,
      kind: "group",
      title,
      dm_key: null,
      revision: 1,
      last_seq: 0,
      last_event_seq: 0,
    });
    for (const user of users) this.join(id, user);
    bodies.forEach((body, i) => {
      this.post(users[i % users.length] ?? users[0] ?? "", id, body);
    });
    return id;
  }

  join(conversationId: string, userId: string): void {
    const conversation = this.must(conversationId);
    this.members.add(userId);
    this.participants.push({
      conversation_id: conversationId,
      user_id: userId,
      joined_seq: conversation.last_seq,
      joined_event_seq: conversation.last_event_seq,
      state: "active",
      pinned: false,
      read_seq: conversation.last_seq,
    });
  }

  /** Removes a member: later reads answer `not_found` like the real store. */
  remove(conversationId: string, userId: string): void {
    const participant = this.participant(conversationId, userId);
    if (participant) participant.state = "removed";
    const conversation = this.must(conversationId);
    conversation.revision += 1;
    this.event(conversation, "membership", null, null);
  }

  /** Server-side post by another member (what a delivery event announces). */
  post(
    author: string,
    conversationId: string,
    body: string,
    options: { client_message_id?: string; reply_to?: string } = {},
  ): Message {
    const conversation = this.must(conversationId);
    conversation.last_seq += 1;
    const message: Message = {
      message_id: this.nextId("msg"),
      conversation_id: conversationId,
      author_id: author,
      kind: "user",
      agent_request_id: null,
      seq: conversation.last_seq,
      client_message_id: options.client_message_id ?? this.nextId("cm"),
      body,
      body_sha256: "0".repeat(64),
      reply_to: options.reply_to ?? null,
      reference_ids: [],
      created_at: this.now(),
      edited_at: null,
      deleted: false,
    };
    this.messages.push(message);
    this.event(conversation, "message", message.seq, message.message_id);
    return message;
  }

  private event(
    conversation: Conversation,
    kind: "message" | "membership" | "reaction",
    message_seq: number | null,
    message_id: string | null,
  ): void {
    conversation.last_event_seq += 1;
    this.outbox.push({
      conversation_id: conversation.conversation_id,
      event_seq: conversation.last_event_seq,
      kind,
      message_seq: message_seq ?? 0,
      message_id,
      revision: conversation.revision,
    });
  }

  private must(conversationId: string): Conversation {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) throw new Error(`fake team: unknown ${conversationId}`);
    return conversation;
  }

  private participant(conversationId: string, userId: string) {
    return this.participants.find(
      (p) => p.conversation_id === conversationId && p.user_id === userId,
    );
  }

  private view(conversationId: string, userId: string) {
    const participant = this.participant(conversationId, userId);
    const conversation = this.conversations.get(conversationId);
    if (!participant || participant.state !== "active" || !conversation)
      throw rpc("not-found", "not_found", 404);
    return {
      participant,
      members: this.participants
        .filter((p) => p.conversation_id === conversationId)
        .map((p) => ({
          user_id: p.user_id,
          state: p.state,
          joined_seq: p.joined_seq,
        })),
    };
  }

  private publicConversation(conversation: Conversation) {
    const { last_event_seq: _ignored, ...rest } = conversation;
    return rest;
  }

  private publicParticipant(participant: Participant) {
    const { joined_event_seq: _ignored, ...rest } = participant;
    return rest;
  }

  private conversationView(conversationId: string, userId: string) {
    const view = this.view(conversationId, userId);
    return {
      conversation: this.publicConversation(this.must(conversationId)),
      participant: this.publicParticipant(view.participant),
      members: view.members,
    };
  }

  /** Transport bound to one authenticated user; `token: null` simulates a missing secret. */
  transport(
    userId: string,
    token: string | null = FAKE_TEAM_TOKEN,
  ): TeamTransport {
    return {
      send: async (request, signal) => {
        if (signal?.aborted) throw rpc("cancelled", undefined, undefined);
        if (!token)
          throw new RpcError("no-token", "No team token is configured.");
        if (token !== FAKE_TEAM_TOKEN)
          throw rpc("unauthorized", "unauthorized", 401);
        this.calls.push(structuredClone(request));
        if (this.offline) throw rpc("disconnected", undefined, undefined);
        if (!this.members.has(userId)) throw rpc("forbidden", "forbidden", 403);
        if (this.disabled && request.method !== "team.describe")
          throw rpc("server", "unavailable", 503);
        if (
          request.method !== "team.describe" &&
          request.context?.team_id !== TEAM_ID
        )
          throw rpc("server", "invalid_request", 400);
        if (
          request.method === "messages.history" &&
          typeof request.params.after_seq === "number" &&
          this.historyFailuresRemaining > 0
        ) {
          this.historyFailuresRemaining -= 1;
          throw rpc("disconnected", undefined, undefined);
        }
        return structuredClone(this.dispatch(userId, request));
      },
    };
  }

  private dispatch(
    userId: string,
    request: RpcRequest<TeamRpcMethod, TeamContext>,
  ): unknown {
    const p = request.params;
    switch (request.method) {
      case "team.describe":
        return {
          team_id: TEAM_ID,
          user_id: userId,
          role: "member",
          enabled: !this.disabled,
          limits: { page_limit: this.pageLimit, max_body_bytes: 16384 },
          // `references` is always present on `main` (PR 4).
          capabilities: { ...this.capabilities, references: false },
        };
      case "conversations.list":
        return [...this.conversations.keys()]
          .filter((id) => this.participant(id, userId)?.state === "active")
          .map((id) => {
            const view = this.conversationView(id, userId);
            // `conversations.list` items carry per-participant counters.
            const rows = this.messages.filter(
              (m) =>
                m.conversation_id === id && m.seq > view.participant.joined_seq,
            );
            return {
              ...view,
              unread_count: rows.filter(
                (m) =>
                  m.seq > view.participant.read_seq && m.author_id !== userId,
              ).length,
              last_message_at: rows.at(-1)?.created_at ?? null,
            };
          });
      case "conversations.open":
        return this.conversationView(String(p.conversation_id), userId);
      case "conversations.mark_read": {
        const view = this.view(String(p.conversation_id), userId);
        const seq = Number(p.read_seq);
        if (seq > this.must(view.participant.conversation_id).last_seq)
          throw rpc("server", "invalid_request", 400);
        view.participant.read_seq = Math.max(view.participant.read_seq, seq);
        return this.publicParticipant(view.participant);
      }
      case "conversations.pin": {
        const view = this.view(String(p.conversation_id), userId);
        view.participant.pinned = Boolean(p.pinned);
        return this.publicParticipant(view.participant);
      }
      case "messages.send": {
        const view = this.view(String(p.conversation_id), userId);
        const existing = this.messages.find(
          (m) =>
            m.conversation_id === view.participant.conversation_id &&
            m.author_id === userId &&
            m.client_message_id === p.client_message_id,
        );
        if (existing) {
          if (existing.body !== p.body) throw rpc("conflict", "conflict", 409);
          return this.decorate(existing, userId, view.participant.joined_seq);
        }
        const message = this.post(
          userId,
          view.participant.conversation_id,
          String(p.body),
          {
            client_message_id: String(p.client_message_id),
            ...(typeof p.reply_to === "string" ? { reply_to: p.reply_to } : {}),
          },
        );
        if (this.dropNextAck) {
          this.dropNextAck = false;
          throw rpc("timeout", undefined, undefined);
        }
        return this.decorate(message, userId, view.participant.joined_seq);
      }
      case "messages.history": {
        const view = this.view(String(p.conversation_id), userId);
        const floor = view.participant.joined_seq;
        const limit = Number(p.limit ?? 50);
        if (limit < 1 || limit > this.pageLimit)
          throw rpc("server", "invalid_request", 400);
        let rows = this.messages
          .filter(
            (m) =>
              m.conversation_id === view.participant.conversation_id &&
              m.seq > floor,
          )
          .sort((a, b) => a.seq - b.seq);
        if (typeof p.after_seq === "number") {
          const after = p.after_seq;
          rows = rows.filter((m) => m.seq > after).slice(0, limit);
        } else {
          const before =
            typeof p.before_seq === "number"
              ? p.before_seq
              : Number.POSITIVE_INFINITY;
          rows = rows.filter((m) => m.seq < before);
          rows = rows.slice(Math.max(0, rows.length - limit));
        }
        if (this.shortPageOnce) {
          this.shortPageOnce = false;
          rows = rows.slice(Math.max(0, rows.length - 1));
        }
        return rows.map((m) => this.decorate(m, userId, floor));
      }
      case "tasks.link_draft": {
        const conversationId = String(p.conversation_id);
        this.view(conversationId, userId);
        const rows = this.messages.filter(
          (row) =>
            row.conversation_id === conversationId &&
            (p.message_ids as string[]).includes(row.message_id),
        );
        const linkId = this.nextId("link");
        const stamp = this.now();
        const link: TaskLink = {
          link_id: linkId,
          launch_key: `launch-${linkId}`,
          team_id: TEAM_ID,
          conversation_id: conversationId,
          requester_id: userId,
          provenance: rows.map(({ message_id, seq, body_sha256 }) => ({
            message_id,
            seq,
            body_sha256,
          })),
          reference_ids: p.reference_ids as string[],
          task_revision: null,
          workbench: null,
          target: null,
          status: "draft",
          created_at: stamp,
          updated_at: stamp,
        };
        this.links.set(linkId, link);
        return {
          link,
          excerpts: rows.map(({ message_id, seq, author_id, body }) => ({
            message_id,
            seq,
            author_id,
            excerpt: body.slice(0, 280),
            truncated: body.length > 280,
          })),
        } satisfies TaskLinkDraftResult;
      }
      case "tasks.link_confirm":
      case "tasks.link_created":
      case "tasks.link_inspect":
      case "shares.preview":
      case "shares.create": {
        const link = this.links.get(String(p.link_id));
        if (!link) throw rpc("server", "not_found", 404);
        const view = this.view(link.conversation_id, userId);
        if (request.method === "tasks.link_inspect") {
          if (link.requester_id === userId) return { view: "requester", link };
          const {
            workbench: _workbench,
            target: _target,
            launch_key: _key,
            ...summary
          } = link;
          return { view: "member", link: summary };
        }
        if (link.requester_id !== userId) throw rpc("server", "forbidden", 403);
        if (request.method === "tasks.link_confirm") {
          link.workbench = TaskLinkWorkbenchSchema.parse(p.workbench);
          link.target = { repo_id: null, base_revision: null };
          if (link.status === "draft") link.status = "confirmed";
          return link;
        }
        if (request.method === "tasks.link_created") {
          link.task_revision = Number(p.task_revision);
          link.status = "created";
          return link;
        }
        const evidence = p.evidence as SharedEvidence;
        const selection = p.selection as {
          summary: string;
          include_diff_digest: boolean;
        };
        const fingerprint = JSON.stringify([evidence, selection, p.run_status]);
        const card: ResultCard = {
          link_id: link.link_id,
          requester_id: userId,
          attested_by: userId,
          summary: selection.summary,
          run_status: p.run_status as Task["status"],
          verified: false,
          verified_reason: "missing",
          task_revision: evidence.task_revision,
          workspace: evidence.workspace,
          diff_sha256: selection.include_diff_digest
            ? evidence.diff_sha256
            : null,
          evidence_event_id: null,
          evidence_sha256: evidence.diff_sha256,
          verify_records: [],
          export_status: "not_exported",
          git_status: "unknown",
        };
        if (request.method === "shares.preview") {
          const digest = fakeSha256(this.nextId("preview"));
          this.sharePreviews.set(link.link_id, { fingerprint, digest });
          return { card, preview_sha256: digest };
        }
        const prior = this.sharePreviews.get(link.link_id);
        if (
          prior?.digest !== p.preview_sha256 ||
          prior?.fingerprint !== fingerprint
        )
          throw rpc("conflict", "conflict", 409);
        const message = this.post(userId, link.conversation_id, card.summary);
        const shareId = this.nextId("share");
        for (const older of this.messages) {
          if (
            older.payload?.link_id === link.link_id &&
            older.payload.evidence_sha256 !== card.evidence_sha256
          ) {
            older.payload.stale = true;
            older.payload.superseded_by = shareId;
          }
        }
        message.kind = "result_card";
        message.payload = {
          ...card,
          share_id: shareId,
          message_id: message.message_id,
          preview_sha256: prior.digest,
          stale: false,
          superseded_by: null,
          created_at: message.created_at,
        };
        link.status = "shared";
        return this.decorate(message, userId, view.participant.joined_seq);
      }
      case "events.poll": {
        const cursors = p.cursors as {
          conversation_id: string;
          after_event_seq: number;
        }[];
        const events: TeamEvent[] = [];
        for (const cursor of cursors) {
          const view = this.view(cursor.conversation_id, userId);
          const conversation = this.must(cursor.conversation_id);
          if (cursor.after_event_seq > conversation.last_event_seq)
            throw rpc("server", "invalid_request", 400);
          for (const event of this.outbox)
            if (
              event.conversation_id === cursor.conversation_id &&
              event.event_seq > cursor.after_event_seq &&
              event.event_seq > view.participant.joined_event_seq
            )
              events.push(event);
        }
        return events.slice(0, Number(p.limit ?? 1000));
      }
      case "reactions.set": {
        if (!this.capabilities.reactions)
          throw rpc("server", "invalid_request", 400);
        const message = this.messages.find(
          (m) => m.message_id === p.message_id,
        );
        if (!message) throw rpc("not-found", "not_found", 404);
        const view = this.view(message.conversation_id, userId);
        const index = this.reactions.findIndex(
          (r) =>
            r.message_id === message.message_id &&
            r.user_id === userId &&
            r.emoji === p.emoji,
        );
        const changed = (p.on && index === -1) || (!p.on && index !== -1);
        if (p.on && index === -1)
          this.reactions.push({
            message_id: message.message_id,
            user_id: userId,
            emoji: String(p.emoji),
          });
        if (!p.on && index !== -1) this.reactions.splice(index, 1);
        if (changed)
          this.event(
            this.must(view.participant.conversation_id),
            "reaction",
            message.seq,
            message.message_id,
          );
        const same = this.reactions.filter(
          (r) => r.message_id === message.message_id && r.emoji === p.emoji,
        );
        return {
          message_id: message.message_id,
          emoji: String(p.emoji),
          count: same.length,
          reacted: same.some((r) => r.user_id === userId),
        };
      }
      case "messages.search": {
        if (!this.capabilities.search)
          throw rpc("server", "invalid_request", 400);
        const needle = String(p.query).toLowerCase();
        if (needle.length < 2) throw rpc("server", "invalid_request", 400);
        const hits = this.messages
          .filter((m) => {
            const participant = this.participant(m.conversation_id, userId);
            return (
              participant?.state === "active" &&
              m.seq > participant.joined_seq &&
              (!p.conversation_id || m.conversation_id === p.conversation_id) &&
              m.body.toLowerCase().includes(needle)
            );
          })
          .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
          .slice(0, Number(p.limit ?? 50))
          .map((m) => ({
            conversation_id: m.conversation_id,
            message_id: m.message_id,
            seq: m.seq,
            author_id: m.author_id,
            created_at: m.created_at,
            excerpt: m.body.slice(0, 200),
            cut_before: false,
            cut_after: m.body.length > 200,
          }));
        return { hits, next_cursor: null };
      }
      default:
        throw rpc("server", "invalid_request", 400);
    }
  }

  /** History/send item as `main` returns it: chips, reaction summaries and the reply excerpt. */
  private decorate(message: Message, userId: string, floor: number): unknown {
    // Per-viewer chips on every history/send result.
    const withChips = {
      ...message,
      references: message.reference_ids.map(
        (id) => this.chips.get(id) ?? { reference_id: id, restricted: true },
      ),
    };
    const summaries = new Map<
      string,
      { emoji: string; count: number; reacted: boolean }
    >();
    for (const r of this.reactions)
      if (r.message_id === message.message_id) {
        const entry = summaries.get(r.emoji) ?? {
          emoji: r.emoji,
          count: 0,
          reacted: false,
        };
        entry.count += 1;
        if (r.user_id === userId) entry.reacted = true;
        summaries.set(r.emoji, entry);
      }
    // Like the real store, a reply target is only ever one of this
    // conversation's messages.
    const target = message.reply_to
      ? this.messages.find(
          (m) =>
            m.message_id === message.reply_to &&
            m.conversation_id === message.conversation_id,
        )
      : undefined;
    const restricted = target !== undefined && target.seq <= floor;
    return {
      ...withChips,
      reactions: [...summaries.values()].sort((a, b) =>
        a.emoji < b.emoji ? -1 : 1,
      ),
      reply_excerpt: target && !restricted ? target.body.slice(0, 200) : null,
      reply_restricted: restricted,
    };
  }

  /** Builds an SSE body (PR 3 frame layout) for the events after the given cursors; `close` ends it on purpose. */
  sseBody(
    cursors: { conversation_id: string; after_event_seq: number }[],
    close?: "membership" | "not_found" | "unavailable" | "internal_error",
  ): string {
    const frames: string[] = [": connected\n\n"];
    for (const cursor of cursors)
      for (const event of this.outbox)
        if (
          event.conversation_id === cursor.conversation_id &&
          event.event_seq > cursor.after_event_seq
        )
          frames.push(
            `id: ${event.event_seq}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`,
          );
    if (close)
      frames.push(
        `event: close\ndata: ${JSON.stringify({ reason: close })}\n\n`,
      );
    return frames.join("");
  }
}

export const HANDOFF_CAPABILITIES = {
  stream: false,
  reactions: false,
  search: false,
  links: true,
  shares: true,
};

export function fakeHandoffWorkbench() {
  const tasks = new Map<string, Task>();
  const creates: { task: Task; launchKey: string | undefined }[] = [];
  const server = {
    scope: { owner_id: "owner", project_id: "project", workspace_id: "ws_1" },
    workspaceLabel: "Test workspace",
    capabilities: { execute: false, checkpoint: false },
  };
  let dropAck = false;
  let diff = "a".repeat(64);
  return {
    server,
    tasks,
    creates,
    loseNextAcknowledgement: () => {
      dropAck = true;
    },
    changeDiff: () => {
      diff = "b".repeat(64);
    },
    async create(task: Task, options?: { launchKey?: string } | AbortSignal) {
      const launchKey =
        options && "launchKey" in options ? options.launchKey : undefined;
      creates.push({ task, launchKey });
      const existing = tasks.get(task.task_id);
      tasks.set(task.task_id, existing ?? task);
      if (dropAck) {
        dropAck = false;
        throw rpc("disconnected", undefined, undefined);
      }
      return existing ?? task;
    },
    async inspect(taskId: string) {
      const task = tasks.get(taskId);
      if (!task) throw new Error("unknown task");
      return task;
    },
    async evidence(taskId: string) {
      const task = await this.inspect(taskId);
      return {
        task_revision: task.revision,
        workspace: {
          workspace_id: "ws_1",
          provider: "git-worktree",
          revision: "abc123",
        },
        diff_sha256: diff,
        verify_records: [],
      };
    },
  };
}

/** Browser-safe stand-in for the sha256 dm key (64 hex chars, deterministic); the harness bundles this file. */
function fakeSha256(input: string): string {
  let hex = "";
  for (let i = 0; i < input.length; i++)
    hex += input.charCodeAt(i).toString(16).padStart(2, "0");
  return (hex + "0".repeat(64)).slice(0, 64);
}

function rpc(
  kind: RpcError["kind"],
  code: string | undefined,
  status: number | undefined,
): RpcError {
  return new RpcError(kind, `fake team ${kind}`, code, status);
}
