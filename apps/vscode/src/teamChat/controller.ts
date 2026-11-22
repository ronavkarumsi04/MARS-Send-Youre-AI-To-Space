import { randomUUID } from "node:crypto";
import {
  AGENT_MAX_MESSAGES,
  SHARE_MAX_VERIFY_EVENT_IDS,
  type Task,
  TaskLinkSchema,
  type TeamDeliveryEvent,
} from "@mars/contracts";
import {
  type AgentPreviewView,
  type AgentRequestView,
  type ConversationSummary,
  type EvidenceSharePreviewView,
  type EvidenceShareView,
  FIXTURE_USERS,
  FixtureTeamService,
  MAX_REFERENCES_PER_MESSAGE,
  type MessageView,
  type PathSearchMatch,
  parseMarsInvocation,
  type SendMessageInput,
  type TaskLinkDraftView,
  type TaskLinkView,
  type TeamErrorCode,
  type TeamResult,
  type TeamService,
} from "@mars/team-chat";
import type { MarsClient } from "../client";
import { sameScope } from "../protocol";
import { buildPendingTask } from "../taskFactory";
import {
  type AgentDraft,
  type PendingSend,
  type SelectedConversation,
  type TeamChatAnnouncement,
  type TeamChatNotice,
  type TeamChatViewState,
  type TeamChatWebviewMessage,
  TeamChatWebviewMessageSchema,
  type TeamConnectionState,
} from "./messages";

/**
 * Delivery source the controller subscribes to. Events carry metadata only;
 * the controller re-reads protected fields through the service.
 */
export interface TeamRealtimeSource {
  /** Replace the set of conversations to follow (the viewer's current inbox). */
  subscribe(conversationIds: readonly string[]): void;
  stop(): void;
}

export interface TeamChatControllerOptions {
  post: (state: TeamChatViewState) => void;
  workbench?: () =>
    | Pick<MarsClient, "server" | "create" | "inspect" | "evidence">
    | undefined;
  service?: TeamService;
  realtime?: TeamRealtimeSource;
  viewer?: string;
  /** Messages per history page; small by default so pagination is visible on the fixture. */
  pageSize?: number;
  /** Simulated acknowledgement delay so pending state is observable. */
  sendDelayMs?: number;
  /** Upper bound on messages kept in memory for the selected conversation. */
  maxLoaded?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_PAGE_SIZE = 3;
const MAX_LOADED = 200;

/** Fixed, content-free reasons shown next to a failed send. */
const SEND_FAILURE_TEXT: Record<TeamErrorCode, string> = {
  not_found: "Conversation is not available to you.",
  forbidden: "You may not post in this conversation.",
  invalid: "The message was rejected as invalid.",
  client_message_id_reused:
    "This message id was already committed with different content. Discard and compose again.",
  conflict:
    "This message id was already committed with different content. Edit and resend.",
  reply_outside_conversation: "The reply target is not in this conversation.",
  reference_not_attachable:
    "A reference could not be attached: no access to that repo or unknown revision.",
  too_many_references: "Too many references on one message.",
  empty_message: "Nothing to send.",
  unavailable:
    "The team service did not acknowledge the send. Retry keeps the same message id.",
  unauthorized: "The team token is missing or was rejected.",
};

const NOTICE_UNAVAILABLE: TeamChatNotice = {
  kind: "error",
  text: "The team service is not reachable.",
};
const NOTICE_DISABLED: TeamChatNotice = {
  kind: "info",
  text: "Team Chat is disabled by the host. Nothing is deleted; reopen the view once it is enabled again.",
};
const NOTICE_UNAUTHORIZED: TeamChatNotice = {
  kind: "error",
  text: "No valid team token. Run “MARS: Set team token”.",
};
const NOTICE_REMOVED: TeamChatNotice = {
  kind: "info",
  text: "A conversation is no longer available to you and was removed.",
};

const REMOVAL_CODES: ReadonlySet<TeamErrorCode> = new Set([
  "not_found",
  "forbidden",
]);

interface Viewport {
  focused: boolean;
  atBottom: boolean;
}

/**
 * Extension-host state machine for Team Chat. The webview only sends
 * validated intents; every read and write goes through the injected
 * `TeamService` (fixture or `@mars/team` adapter) and the webview receives
 * view state only: no tokens, no service handles, no transport errors.
 *
 * Conversation operations are serialized so a delivery event and a send
 * acknowledgement cannot interleave their reads. Path searches are independent.
 */
export class TeamChatController {
  private readonly service: TeamService;
  private readonly pageSize: number;
  private readonly maxLoaded: number;
  private viewer: string;
  private conversations: ConversationSummary[] = [];
  private selected: SelectedConversation | null = null;
  private readonly pending: PendingSend[] = [];
  private readonly pendingInputs = new Map<string, SendMessageInput>();
  private readonly pendingAgentRequests = new Map<
    string,
    {
      conversationId: string;
      messageIds: string[];
      referenceIds: string[];
      idempotencyKey: string;
    }
  >();
  private panel: TeamChatViewState["panel"] = null;
  private pathSearch: PathSearchMatch[] = [];
  private pathSearchId: string | null = null;
  private pathSearchGeneration = 0;
  private pathSearchTimer: ReturnType<typeof setTimeout> | undefined;
  private agentPreviewState: AgentPreviewView | null = null;
  private agentDraft: (AgentDraft & { conversationId: string }) | null = null;
  private agentRequestState: AgentRequestView | null = null;
  private taskLinkDraftState: TaskLinkDraftView | null = null;
  private pendingLinkedTask: { task: Task; requestId: string } | null = null;
  private taskLinkState: TaskLinkView | null = null;
  private sharePreviewState: EvidenceSharePreviewView | null = null;
  private shareResultState: EvidenceShareView | null = null;
  private shareSelection:
    | Parameters<NonNullable<TeamService["sharePreview"]>>[1]["selection"]
    | null = null;
  private notice: TeamChatNotice | null = null;
  private search: TeamChatViewState["search"] = null;
  private announcement: TeamChatAnnouncement | null = null;
  private announcementSeq = 0;
  private connection: TeamConnectionState = "offline";
  private viewport: Viewport = { focused: false, atBottom: false };
  private queue: Promise<void> = Promise.resolve();
  private disposedFlag = false;

  constructor(private readonly options: TeamChatControllerOptions) {
    this.service = options.service ?? new FixtureTeamService();
    this.pageSize = Math.max(1, options.pageSize ?? DEFAULT_PAGE_SIZE);
    this.maxLoaded = Math.max(this.pageSize, options.maxLoaded ?? MAX_LOADED);
    this.viewer = options.viewer ?? FIXTURE_USERS.ada;
  }

  get disposed(): boolean {
    return this.disposedFlag;
  }

  get currentViewer(): string {
    return this.me();
  }

  /** The authenticated identity: server-derived for the service, the chosen fixture user otherwise. */
  private me(): string {
    return this.service.currentUser?.() ?? this.viewer;
  }

  dispose(): void {
    this.disposedFlag = true;
    this.clearPathSearch();
    this.options.realtime?.stop();
  }

  refreshMentionIndex(): void {
    this.emit();
  }

  /** Waits for every queued operation to settle (tests and shutdown). */
  idle(): Promise<void> {
    return this.queue;
  }

  private run(task: () => Promise<void> | void): Promise<void> {
    const next = this.queue.then(async () => {
      if (this.disposedFlag) return;
      await task();
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Validates and dispatches one untrusted webview message. */
  async handleMessage(raw: unknown): Promise<boolean> {
    const parsed = TeamChatWebviewMessageSchema.safeParse(raw);
    if (!parsed.success || this.disposedFlag) return false;
    const message = parsed.data;
    if (message.type === "searchPaths") this.schedulePathSearch(message);
    else await this.run(() => this.dispatch(message));
    return true;
  }

  /**
   * Called by the realtime source for each delivery event. Only the
   * conversation id and kind are trusted; everything else is re-read.
   */
  notifyDelivery(
    conversationId: string,
    kind: TeamDeliveryEvent["kind"],
    messageSeq?: number,
  ): Promise<void> {
    return this.run(async () => {
      if (kind === "edit" && messageSeq !== undefined)
        this.service.forgetMessage?.(conversationId, messageSeq);
      const known = this.conversations.some(
        (c) => c.conversation_id === conversationId,
      );
      if (!known) {
        await this.refreshInbox();
        return this.emit();
      }
      const before = this.selected?.conversation.last_sequence ?? null;
      await this.refreshInbox();
      const still = this.conversations.find(
        (c) => c.conversation_id === conversationId,
      );
      if (!still) {
        this.forget(conversationId);
        return this.emit();
      }
      if (this.selected?.conversation.conversation_id === conversationId) {
        const grow = Math.max(
          1,
          still.last_sequence - (before ?? still.last_sequence),
        );
        await this.reloadSelected(grow);
        if (kind === "message" && this.selected) {
          const fresh = this.selected.messages.filter(
            (m) =>
              before !== null &&
              m.sequence > before &&
              m.author_id !== this.me(),
          );
          if (fresh.length > 0) this.announce(still, fresh.length);
          await this.markReadIfBoundaryLoaded();
        }
      } else if (kind === "message" && still.unread_count > 0) {
        this.announce(still, 1);
      }
      this.emit();
    });
  }

  /** Called by the realtime source when its connection state changes. */
  notifyConnection(state: TeamConnectionState): Promise<void> {
    return this.run(async () => {
      if (this.connection === state) return;
      this.connection = state;
      if (state === "live" || state === "polling") {
        const selected = this.selected;
        const conversationId = selected?.conversation.conversation_id;
        const afterSequence = selected?.conversation.last_sequence;
        await this.refreshInbox();
        if (
          conversationId &&
          afterSequence !== undefined &&
          this.selected?.conversation.conversation_id === conversationId
        ) {
          const summary = this.conversations.find(
            (conversation) => conversation.conversation_id === conversationId,
          );
          if (summary) {
            if (summary.last_sequence > afterSequence)
              await this.reloadSelectedAfter(
                conversationId,
                afterSequence,
                summary,
              );
            else
              this.selected = {
                ...this.selected,
                conversation: summary,
              };
          }
        }
      }
      this.emit();
    });
  }

  /** Drops every cached conversation, message, draft and search (token cleared or source changed). */
  reset(): Promise<void> {
    return this.run(() => {
      this.conversations = [];
      this.selected = null;
      this.panel = null;
      this.clearPathSearch();
      this.agentPreviewState = null;
      this.agentDraft = null;
      this.agentRequestState = null;
      this.clearHandoff();
      this.notice = null;
      this.search = null;
      this.announcement = null;
      this.pending.splice(0, this.pending.length);
      this.pendingInputs.clear();
      this.pendingAgentRequests.clear();
      this.options.realtime?.subscribe([]);
      this.emit();
    });
  }

  private async dispatch(
    message: Exclude<TeamChatWebviewMessage, { type: "searchPaths" }>,
  ): Promise<void> {
    switch (message.type) {
      case "ready":
        await this.refreshInbox();
        if (!this.selected) {
          const first = this.conversations[0];
          if (first) await this.select(first.conversation_id);
        }
        return this.emit();
      case "selectConversation":
        await this.select(message.conversationId);
        return this.emit();
      case "loadOlder":
        await this.loadOlder(message.conversationId, message.cursor);
        return this.emit();
      case "send":
        await this.send({
          conversation_id: message.conversationId,
          client_message_id: message.clientMessageId,
          body: message.body,
          reply_to: message.replyTo,
          references: message.references,
        });
        return;
      case "retrySend": {
        const input = this.pendingInputs.get(message.clientMessageId);
        const item = this.pending.find(
          (p) => p.client_message_id === message.clientMessageId,
        );
        if (!input || item?.status === "conflict") return;
        const followup = this.pendingAgentRequests.get(message.clientMessageId);
        const sent = await this.send(input, followup !== undefined);
        if (sent && followup) {
          await this.requestForSentDraft(sent.sequence, followup);
          this.emit();
        }
        return;
      }
      case "discardSend":
        this.removePending(message.clientMessageId);
        return this.emit();
      case "viewport":
        this.viewport = {
          focused: message.focused,
          atBottom: message.atBottom,
        };
        await this.markReadIfBoundaryLoaded();
        return this.emit();
      case "markRead":
        if (!this.viewport.focused || !this.viewport.atBottom) return;
        await this.markRead(message.conversationId, message.sequence);
        return this.emit();
      case "togglePin":
        await this.togglePin(message.conversationId);
        return this.emit();
      case "toggleReaction":
        await this.toggleReaction(message.messageId, message.emoji);
        return this.emit();
      case "openReference":
        await this.openReference(message.messageId, message.referenceId);
        return this.emit();
      case "closeReference":
        this.panel = null;
        return this.emit();
      case "search":
        await this.runSearch(message.query);
        return this.emit();
      case "clearSearch":
        this.search = null;
        return this.emit();
      case "openSearchHit":
        await this.openHit(
          message.conversationId,
          message.messageId,
          message.sequence,
        );
        return this.emit();
      case "fixtureSwitchViewer":
        await this.switchViewer(message.userId);
        return this.emit();
      case "agentPreview":
        await this.runAgentPreview(
          message.conversationId,
          message.messageIds,
          message.referenceIds,
          message.draft,
        );
        return this.emit();
      case "agentRequest":
        await this.runAgentRequest(
          message.conversationId,
          message.messageIds,
          message.referenceIds,
          message.idempotencyKey,
          message.previewSha256,
        );
        return this.emit();
      case "agentConfirmDraft":
        await this.confirmAgentDraft(
          message.clientMessageId,
          message.idempotencyKey,
          message.previewSha256,
        );
        return this.emit();
      case "agentCancel":
        await this.runAgentCancel(message.requestId);
        return this.emit();
      case "agentInspect":
        await this.runAgentInspect(message.requestId);
        return this.emit();
      case "clearAgent":
        this.agentPreviewState = null;
        this.agentDraft = null;
        this.agentRequestState = null;
        return this.emit();
      case "taskLinkDraft":
        await this.runTaskLinkDraft(
          message.conversationId,
          message.messageIds,
          message.referenceIds,
        );
        return this.emit();
      case "taskLinkConfirm":
        await this.runTaskLinkConfirm(message);
        return this.emit();
      case "taskLinkInspect":
        await this.runTaskLinkInspect(message.linkId);
        return this.emit();
      case "clearTaskLink":
        this.clearHandoff();
        return this.emit();
      case "sharePreview":
        await this.runSharePreview(message);
        return this.emit();
      case "shareCreate":
        await this.runShareCreate(message);
        return this.emit();
      case "clearShare":
        this.clearShare();
        return this.emit();
    }
  }

  // ---------------------------------------------------------------- reads

  /** Maps a failed service result to a notice; removal codes on a known conversation drop it. */
  private failed(code: TeamErrorCode, conversationId?: string): void {
    if (code === "unavailable") {
      if (this.service.disabled?.() === true) {
        this.notice = NOTICE_DISABLED;
        this.connection = "disabled";
      } else this.notice = NOTICE_UNAVAILABLE;
    } else if (code === "unauthorized") {
      this.notice = NOTICE_UNAUTHORIZED;
      this.connection = "unauthenticated";
    } else if (conversationId && REMOVAL_CODES.has(code))
      this.forget(conversationId);
  }

  /** Removes a conversation the viewer can no longer see, with every cached message and draft. */
  private forget(conversationId: string): void {
    const index = this.conversations.findIndex(
      (c) => c.conversation_id === conversationId,
    );
    const wasKnown = index !== -1;
    if (wasKnown) this.conversations.splice(index, 1);
    if (this.selected?.conversation.conversation_id === conversationId) {
      this.selected = null;
      this.panel = null;
      this.clearHandoff();
    }
    if (this.agentDraft?.conversationId === conversationId)
      this.agentDraft = null;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const item = this.pending[i];
      if (item && item.conversation_id === conversationId) {
        this.pending.splice(i, 1);
        this.pendingInputs.delete(item.client_message_id);
        this.pendingAgentRequests.delete(item.client_message_id);
      }
    }
    if (this.search)
      this.search = {
        ...this.search,
        hits: this.search.hits.filter(
          (h) => h.conversation_id !== conversationId,
        ),
      };
    if (wasKnown) this.notice = NOTICE_REMOVED;
    this.options.realtime?.subscribe(
      this.conversations.map((c) => c.conversation_id),
    );
  }

  private async refreshInbox(): Promise<void> {
    const result = await this.service.listConversations(this.viewer);
    if (!result.ok) {
      this.failed(result.code);
      if (result.code !== "unavailable") {
        this.conversations = [];
        this.selected = null;
      }
      return;
    }
    this.conversations = result.value;
    if (this.connection === "unauthenticated" || this.connection === "disabled")
      this.connection = "offline";
    // A successful list ends a connection-level notice; content notices stay.
    if (this.notice === NOTICE_DISABLED || this.notice === NOTICE_UNAVAILABLE)
      this.notice = null;
    const ids = new Set(this.conversations.map((c) => c.conversation_id));
    if (this.selected && !ids.has(this.selected.conversation.conversation_id))
      this.forget(this.selected.conversation.conversation_id);
    else
      this.options.realtime?.subscribe(
        this.conversations.map((c) => c.conversation_id),
      );
  }

  private async select(conversationId: string): Promise<void> {
    this.notice = null;
    if (this.selected?.conversation.conversation_id !== conversationId) {
      this.panel = null;
      this.agentDraft = null;
      this.agentPreviewState = null;
      this.clearHandoff();
    }
    const page = await this.service.openConversation(
      this.viewer,
      conversationId,
      { limit: this.pageSize },
    );
    if (!page.ok) {
      this.selected = null;
      this.failed(page.code, conversationId);
      if (!this.notice)
        this.notice = {
          kind: "error",
          text: "That conversation is not available.",
        };
      return;
    }
    this.selected = {
      conversation: page.value.conversation,
      messages: page.value.messages,
      older_cursor: page.value.older_cursor,
      older_blocked: false,
      // The first visible unread sequence (after the member's join point),
      // whether or not that page is loaded yet.
      divider_sequence: page.value.conversation.first_unread_sequence,
      highlight_message_id: null,
    };
    this.reconcilePending();
    await this.markReadIfBoundaryLoaded();
  }

  /**
   * Selects the hit's conversation, pages back until its sequence is loaded
   * (bounded by the in-memory cap) and marks it for highlighting.
   */
  private async openHit(
    conversationId: string,
    messageId: string,
    sequence: number,
  ): Promise<void> {
    if (this.selected?.conversation.conversation_id !== conversationId)
      await this.select(conversationId);
    // Page back while the hit is older than what is loaded and each page
    // still advances; the in-memory cap (older_blocked) or an exhausted
    // cursor ends the walk.
    for (;;) {
      const selected = this.selected;
      if (selected?.conversation.conversation_id !== conversationId) return;
      const earliest = selected.messages[0]?.sequence;
      if (
        earliest === undefined ||
        earliest <= sequence ||
        selected.older_cursor === null
      )
        break;
      const cursor = selected.older_cursor;
      await this.loadOlder(conversationId, cursor);
      const next = this.selected;
      if (
        next?.conversation.conversation_id !== conversationId ||
        next.older_cursor === cursor ||
        (next.messages[0]?.sequence ?? earliest) >= earliest
      )
        break;
    }
    const selected = this.selected;
    if (selected?.conversation.conversation_id !== conversationId) return;
    if (selected.messages.some((m) => m.message_id === messageId))
      this.selected = { ...selected, highlight_message_id: messageId };
    else
      this.notice = {
        kind: "info",
        text: "That message is not loaded (in-memory limit reached).",
      };
  }

  /**
   * Advances the read cursor to the latest message only once the first unread
   * message is actually loaded and the viewer is looking at the bottom of a
   * focused view; unread history on older pages stays unread.
   */
  private async markReadIfBoundaryLoaded(): Promise<void> {
    const selected = this.selected;
    if (!selected) return;
    if (!this.viewport.focused || !this.viewport.atBottom) return;
    const firstUnread = selected.conversation.first_unread_sequence;
    const last = selected.conversation.last_sequence;
    if (firstUnread === null || last <= selected.conversation.read_cursor)
      return;
    const earliest = selected.messages[0]?.sequence;
    const exhausted = selected.older_cursor === null && !selected.older_blocked;
    const boundaryLoaded =
      exhausted || (earliest !== undefined && earliest <= firstUnread);
    if (boundaryLoaded)
      await this.markRead(selected.conversation.conversation_id, last);
  }

  private async loadOlder(
    conversationId: string,
    cursor: string,
  ): Promise<void> {
    if (this.selected?.conversation.conversation_id !== conversationId) return;
    if (this.selected.older_cursor !== cursor) return;
    const page = await this.service.openConversation(
      this.viewer,
      conversationId,
      { before: cursor, limit: this.pageSize },
    );
    if (!page.ok) {
      this.failed(page.code, conversationId);
      if (!this.notice)
        this.notice = {
          kind: "error",
          text: "Older history is not available.",
        };
      return;
    }
    if (this.selected?.conversation.conversation_id !== conversationId) return;
    const known = new Set(this.selected.messages.map((m) => m.message_id));
    const older = page.value.messages.filter((m) => !known.has(m.message_id));
    const messages = [...older, ...this.selected.messages];
    // Never drop a fetched page: once the in-memory cap is reached the older
    // cursor is withheld (and flagged as blocked, not exhausted) instead of
    // silently skipping history.
    const blocked =
      page.value.older_cursor !== null && messages.length >= this.maxLoaded;
    this.selected = {
      ...this.selected,
      messages,
      older_cursor: blocked ? null : page.value.older_cursor,
      older_blocked: blocked,
    };
    await this.markReadIfBoundaryLoaded();
  }

  /** Re-reads the selected conversation keeping everything already loaded plus `grow` new messages. */
  private async reloadSelected(grow: number): Promise<void> {
    if (!this.selected) return;
    const id = this.selected.conversation.conversation_id;
    const limit = Math.min(
      this.maxLoaded,
      Math.max(this.pageSize, this.selected.messages.length + grow),
    );
    const page = await this.service.openConversation(this.viewer, id, {
      limit,
    });
    if (!page.ok) {
      this.failed(page.code, id);
      if (!REMOVAL_CODES.has(page.code)) return;
      this.selected = null;
      this.panel = null;
      return;
    }
    if (this.selected?.conversation.conversation_id !== id) return;
    const blocked =
      page.value.older_cursor !== null &&
      page.value.messages.length >= this.maxLoaded;
    this.selected = {
      ...this.selected,
      conversation: page.value.conversation,
      messages: page.value.messages,
      older_cursor: blocked ? null : page.value.older_cursor,
      older_blocked: blocked,
    };
    this.reconcilePending();
  }

  private async reloadSelectedAfter(
    conversationId: string,
    afterSequence: number,
    summary: ConversationSummary,
  ): Promise<void> {
    const selected = this.selected;
    if (selected?.conversation.conversation_id !== conversationId) return;
    const maxMessages = Math.max(0, this.maxLoaded - selected.messages.length);
    const result = await this.service.historyAfter?.(
      this.viewer,
      conversationId,
      afterSequence,
      maxMessages,
    );
    if (result && !result.ok) {
      this.failed(result.code, conversationId);
      return;
    }
    const reloadNewest = async () => {
      await this.reloadSelected(
        Math.max(1, summary.last_sequence - afterSequence),
      );
      if (
        this.selected?.conversation.conversation_id === conversationId &&
        this.selected.conversation.last_sequence >= summary.last_sequence
      )
        await this.markReadIfBoundaryLoaded();
    };
    if (!result || result.value.length === 0) {
      await reloadNewest();
      return;
    }
    const messages = new Map(
      selected.messages.map((message) => [message.message_id, message]),
    );
    for (const message of result.value)
      messages.set(message.message_id, message);
    if (messages.size > this.maxLoaded) {
      await reloadNewest();
      return;
    }
    this.selected = {
      ...selected,
      conversation: summary,
      messages: [...messages.values()].sort((a, b) => a.sequence - b.sequence),
    };
    this.reconcilePending();
    await this.markReadIfBoundaryLoaded();
  }

  /** A pending send whose `client_message_id` is now in the loaded history was acknowledged out of band. */
  private reconcilePending(): void {
    if (!this.selected) return;
    const committed = new Set(
      this.selected.messages.map((m) => m.client_message_id),
    );
    for (const item of [...this.pending])
      if (committed.has(item.client_message_id))
        this.removePending(item.client_message_id);
  }

  private async markRead(
    conversationId: string,
    sequence: number,
  ): Promise<void> {
    const result = await this.service.markRead(
      this.viewer,
      conversationId,
      sequence,
    );
    if (!result.ok) {
      this.failed(result.code, conversationId);
      return;
    }
    await this.refreshInbox();
    if (this.selected?.conversation.conversation_id === conversationId) {
      const summary = this.conversations.find(
        (c) => c.conversation_id === conversationId,
      );
      if (summary) this.selected = { ...this.selected, conversation: summary };
    }
  }

  private async runSearch(query: string): Promise<void> {
    const result = await this.service.searchMessages(this.viewer, query, null);
    if (!result.ok) {
      this.search = { query, hits: [] };
      this.failed(result.code);
      return;
    }
    const visible = new Set(this.conversations.map((c) => c.conversation_id));
    this.search = {
      query: result.value.query,
      hits: result.value.hits.filter((h) => visible.has(h.conversation_id)),
    };
  }

  // ---------------------------------------------------------------- writes

  private async send(
    input: SendMessageInput,
    confirmedAgentDraft = false,
  ): Promise<{ sequence: number; duplicate: boolean } | null> {
    if (
      !confirmedAgentDraft &&
      parseMarsInvocation(input.body, {
        teammates: this.service.mentionIndex(this.viewer).users,
        leadingOnly: !this.service.capabilities.agent,
      })
    ) {
      this.notice = {
        kind: "error",
        text: "Preview and confirm your @MARS question before sending.",
      };
      this.emit();
      return null;
    }
    const existing = this.pending.find(
      (p) => p.client_message_id === input.client_message_id,
    );
    if (existing?.status === "pending") return null;
    if (existing) {
      existing.status = "pending";
      existing.reason = null;
    } else
      this.pending.push({
        client_message_id: input.client_message_id,
        conversation_id: input.conversation_id,
        body: input.body,
        reference_count: input.references.length,
        reply_to: input.reply_to,
        status: "pending",
        reason: null,
      });
    this.pendingInputs.set(input.client_message_id, input);
    this.notice = null;
    this.emit();
    const delay = this.options.sendDelayMs ?? 0;
    if (delay > 0) await (this.options.sleep ?? defaultSleep)(delay);
    if (this.disposedFlag) return null;
    const result: TeamResult<{ sequence: number; duplicate: boolean }> =
      await this.service.sendMessage(this.viewer, input);
    const item = this.pending.find(
      (p) => p.client_message_id === input.client_message_id,
    );
    if (!item) return null;
    if (result.ok) {
      this.removePending(input.client_message_id);
      await this.refreshInbox();
      await this.reloadSelected(result.value.duplicate ? 0 : 1);
      if (this.viewport.focused && this.viewport.atBottom)
        await this.markRead(input.conversation_id, result.value.sequence);
      this.emit();
      return result.value;
    } else if (
      REMOVAL_CODES.has(result.code) &&
      this.conversations.some(
        (c) => c.conversation_id === input.conversation_id,
      )
    ) {
      this.failed(result.code, input.conversation_id);
    } else {
      item.status =
        result.code === "conflict" || result.code === "client_message_id_reused"
          ? "conflict"
          : "failed";
      item.reason = SEND_FAILURE_TEXT[result.code];
      if (result.code === "unauthorized") this.failed(result.code);
    }
    this.emit();
    return null;
  }

  private removePending(clientMessageId: string): void {
    const index = this.pending.findIndex(
      (p) => p.client_message_id === clientMessageId,
    );
    if (index !== -1) this.pending.splice(index, 1);
    this.pendingInputs.delete(clientMessageId);
    this.pendingAgentRequests.delete(clientMessageId);
  }

  private async togglePin(conversationId: string): Promise<void> {
    const summary = this.conversations.find(
      (c) => c.conversation_id === conversationId,
    );
    if (!summary) return;
    const result = await this.service.setPinned(
      this.viewer,
      conversationId,
      !summary.pinned,
    );
    if (!result.ok) {
      this.failed(result.code, conversationId);
      return;
    }
    await this.refreshInbox();
    if (this.selected?.conversation.conversation_id === conversationId)
      this.selected = {
        ...this.selected,
        conversation: {
          ...this.selected.conversation,
          pinned: result.value.pinned,
        },
      };
  }

  private async toggleReaction(
    messageId: string,
    emoji: Parameters<TeamService["setReaction"]>[2],
  ): Promise<void> {
    if (!this.service.capabilities.reactions) return;
    const message = this.selected?.messages.find(
      (m) => m.message_id === messageId,
    );
    if (!message) return;
    const conversationId = message.conversation_id;
    const mine = message.reactions.some((r) => r.emoji === emoji && r.mine);
    const result = await this.service.setReaction(
      this.viewer,
      messageId,
      emoji,
      !mine,
    );
    if (!result.ok) {
      this.failed(result.code, conversationId);
      return;
    }
    if (!this.selected) return;
    const messages: MessageView[] = this.selected.messages.map((m) =>
      m.message_id === messageId
        ? { ...m, reactions: result.value.reactions }
        : m,
    );
    this.selected = { ...this.selected, messages };
  }

  private async openReference(
    messageId: string,
    referenceId: string,
  ): Promise<void> {
    const result = await this.service.resolveReference(
      this.viewer,
      messageId,
      referenceId,
    );
    if (!result.ok) {
      this.panel = null;
      this.notice = { kind: "error", text: "That reference is not available." };
      return;
    }
    this.panel = {
      message_id: messageId,
      reference_id: referenceId,
      preview: result.value,
    };
  }

  private clearPathSearch(): void {
    clearTimeout(this.pathSearchTimer);
    this.pathSearchGeneration += 1;
    this.pathSearch = [];
    this.pathSearchId = null;
  }

  private schedulePathSearch(
    message: Extract<TeamChatWebviewMessage, { type: "searchPaths" }>,
  ): void {
    this.clearPathSearch();
    if (!message.query || message.repositories.length === 0) return;
    const generation = this.pathSearchGeneration;
    this.pathSearchTimer = setTimeout(() => {
      void this.runPathSearch(generation, message);
    }, 125);
  }

  private async runPathSearch(
    generation: number,
    {
      repositories,
      query,
      limit,
      searchId,
    }: Extract<TeamChatWebviewMessage, { type: "searchPaths" }>,
  ): Promise<void> {
    const search = this.service.searchPaths?.bind(this.service);
    if (!search) return;
    const viewer = this.viewer;
    const matches: PathSearchMatch[][] = [];
    let index = 0;
    const worker = async () => {
      while (generation === this.pathSearchGeneration) {
        const slot = index++;
        const repo = repositories[slot];
        if (!repo) return;
        try {
          const result = await search(viewer, {
            repo_id: repo.repoId,
            commit_sha: repo.commitSha,
            query,
            ...(limit !== undefined ? { limit } : {}),
          });
          matches[slot] = result.ok ? result.value : [];
        } catch {
          matches[slot] = [];
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(4, repositories.length) }, worker),
    );
    if (generation !== this.pathSearchGeneration || this.disposedFlag) return;
    this.pathSearch = matches.flat();
    this.pathSearchId = searchId;
    this.emit();
  }

  private async runAgentPreview(
    conversationId: string,
    messageIds: string[],
    referenceIds: string[],
    draft?: AgentDraft,
  ): Promise<void> {
    this.agentDraft = null;
    this.agentPreviewState = null;
    this.notice = null;
    if (!this.service.agentPreview) {
      this.notice = {
        kind: "error",
        text: "@MARS is not enabled on this team service.",
      };
      return;
    }
    const messages = [...new Set(messageIds)].slice(
      -(AGENT_MAX_MESSAGES - (draft ? 1 : 0)),
    );
    const references = [...new Set(referenceIds)].slice(
      0,
      MAX_REFERENCES_PER_MESSAGE - (draft?.references.length ?? 0),
    );
    if (messages.length || references.length) {
      const preview = await this.previewAgentContext(
        conversationId,
        messages,
        references,
      );
      if (!preview) return;
      this.agentPreviewState = preview;
    } else if (!draft) {
      return;
    }
    if (
      draft &&
      this.selected?.conversation.conversation_id === conversationId
    ) {
      this.agentDraft = { ...draft, conversationId };
    }
  }

  private async previewAgentContext(
    conversationId: string,
    messageIds: string[],
    referenceIds: string[],
  ): Promise<AgentPreviewView | null> {
    if (!this.service.agentPreview) return null;
    const selection = {
      conversation_id: conversationId,
      message_ids: messageIds,
      reference_ids: referenceIds,
    };
    this.notice = null;
    const result = await this.service.agentPreview(this.viewer, selection);
    if (!result.ok) {
      this.failed(result.code, conversationId);
      if (!this.notice && !REMOVAL_CODES.has(result.code)) {
        this.notice = this.noticeForAgentError(result.code, "preview");
      }
      return null;
    }
    const restricted = new Set(result.value.restricted_reference_ids);
    if (!restricted.size) return result.value;
    const filtered = await this.service.agentPreview(this.viewer, {
      ...selection,
      reference_ids: referenceIds.filter((id) => !restricted.has(id)),
    });
    if (!filtered.ok) return result.value;
    this.notice = {
      kind: "info",
      text: `Omitted ${restricted.size} restricted code reference(s) not readable by every participant.`,
    };
    return filtered.value;
  }

  private agentContext(preview: AgentPreviewView | null) {
    return {
      messageIds:
        preview?.items.flatMap((item) =>
          item.kind === "message" && item.message_id ? [item.message_id] : [],
        ) ?? [],
      referenceIds:
        preview?.items.flatMap((item) =>
          item.kind === "reference" && item.reference_id
            ? [item.reference_id]
            : [],
        ) ?? [],
    };
  }

  private async confirmAgentDraft(
    clientMessageId: string,
    idempotencyKey: string,
    previewSha256: string | null,
  ): Promise<void> {
    const draft = this.agentDraft;
    if (
      !draft ||
      draft.clientMessageId !== clientMessageId ||
      this.selected?.conversation.conversation_id !== draft.conversationId
    )
      return;
    const conversationId = draft.conversationId;
    const preview = this.agentPreviewState;
    if ((preview?.preview_sha256 ?? null) !== previewSha256) return;
    const { messageIds, referenceIds } = this.agentContext(preview);
    if (preview) {
      if (preview.restricted_reference_ids.length) return;
      const fresh = await this.previewAgentContext(
        conversationId,
        messageIds,
        referenceIds,
      );
      if (!fresh) return;
      if (fresh.preview_sha256 !== preview.preview_sha256) {
        this.agentPreviewState = fresh;
        this.notice = {
          kind: "info",
          text: "The @MARS context changed. Review it before confirming again.",
        };
        await this.reloadSelected(0);
        return;
      }
    }
    this.agentDraft = null;
    this.agentPreviewState = null;
    const followup = {
      conversationId,
      messageIds,
      referenceIds,
      idempotencyKey,
    };
    const sent = await this.send(
      {
        conversation_id: conversationId,
        client_message_id: clientMessageId,
        body: draft.body,
        reply_to: draft.replyTo,
        references: draft.references,
      },
      true,
    );
    if (sent) await this.requestForSentDraft(sent.sequence, followup);
    else if (this.pendingInputs.has(clientMessageId))
      this.pendingAgentRequests.set(clientMessageId, followup);
  }

  private async requestForSentDraft(
    sequence: number,
    {
      conversationId,
      messageIds,
      referenceIds,
      idempotencyKey,
    }: {
      conversationId: string;
      messageIds: string[];
      referenceIds: string[];
      idempotencyKey: string;
    },
  ): Promise<void> {
    const sent = this.selected?.messages.find(
      (message) =>
        message.conversation_id === conversationId &&
        message.sequence === sequence,
    );
    if (!sent) {
      this.notice = {
        kind: "error",
        text: "The posted @MARS question could not be loaded. Ask from the message to try again.",
      };
      return;
    }
    const preview = await this.previewAgentContext(
      conversationId,
      [...new Set([...messageIds, sent.message_id])].slice(-AGENT_MAX_MESSAGES),
      [
        ...new Set([
          ...sent.references.map((ref) => ref.reference_id),
          ...referenceIds,
        ]),
      ].slice(0, MAX_REFERENCES_PER_MESSAGE),
    );
    if (!preview) return;
    if (preview.restricted_reference_ids.length) {
      this.agentPreviewState = preview;
      return;
    }
    const notice = this.notice;
    const context = this.agentContext(preview);
    await this.runAgentRequest(
      conversationId,
      context.messageIds,
      context.referenceIds,
      idempotencyKey,
      preview.preview_sha256,
    );
    this.notice ??= notice;
  }

  private async runAgentRequest(
    conversationId: string,
    messageIds: string[],
    referenceIds: string[],
    idempotencyKey: string,
    previewSha256: string,
  ): Promise<void> {
    if (!this.service.agentRequest) {
      this.notice = {
        kind: "error",
        text: "@MARS is not enabled on this team service.",
      };
      return;
    }
    const result = await this.service.agentRequest(this.viewer, {
      conversation_id: conversationId,
      message_ids: messageIds,
      reference_ids: referenceIds,
      idempotency_key: idempotencyKey,
      preview_sha256: previewSha256,
    });
    if (!result.ok) {
      this.notice = null;
      this.failed(result.code, conversationId);
      if (!this.notice && !REMOVAL_CODES.has(result.code)) {
        this.notice = this.noticeForAgentError(result.code, "request");
      }
      return;
    }
    this.notice = null;
    this.agentPreviewState = null;
    this.agentRequestState = result.value;
  }

  private noticeForAgentError(
    code: TeamErrorCode,
    phase: "preview" | "request",
  ): TeamChatNotice {
    if (code === "invalid") {
      return {
        kind: "error",
        text:
          phase === "preview"
            ? "Could not build @MARS preview: selected messages or attached code references exceed the agent context limit."
            : "Could not submit @MARS request: selection is invalid or exceeds the agent context limit.",
      };
    }
    if (code === "conflict") {
      return {
        kind: "error",
        text: "The @MARS preview is out of date. Re-preview before confirming.",
      };
    }
    if (code === "forbidden") {
      return {
        kind: "error",
        text: "Not every participant can read the selected @MARS context.",
      };
    }
    return {
      kind: "error",
      text: `@MARS ${phase} failed (${code}).`,
    };
  }

  private async runAgentCancel(requestId: string): Promise<void> {
    if (!this.service.agentCancel) return;
    const result = await this.service.agentCancel(this.viewer, requestId);
    if (!result.ok) {
      this.failed(result.code);
      return;
    }
    this.agentRequestState = result.value;
  }

  private async runAgentInspect(requestId: string): Promise<void> {
    if (!this.service.agentInspect) return;
    const result = await this.service.agentInspect(this.viewer, requestId);
    if (!result.ok) {
      this.failed(result.code);
      return;
    }
    this.agentRequestState = result.value;
  }

  private async runTaskLinkDraft(
    conversationId: string,
    messageIds: string[],
    referenceIds: string[],
  ): Promise<void> {
    if (this.selected?.conversation.conversation_id !== conversationId) return;
    if (!this.service.taskLinkDraft) {
      this.notice = {
        kind: "error",
        text: "Task links are not supported by this team service.",
      };
      return;
    }
    const result = await this.service.taskLinkDraft(this.viewer, {
      conversation_id: conversationId,
      message_ids: messageIds,
      reference_ids: referenceIds,
    });
    if (!result.ok) {
      this.failed(result.code, conversationId);
      return;
    }
    if (
      result.value.link.conversation_id !== conversationId ||
      result.value.link.requester_id !== this.me()
    ) {
      this.handoffError("The task draft does not match this conversation.");
      return;
    }
    this.notice = null;
    this.clearHandoff();
    this.taskLinkDraftState = result.value;
  }

  private handoffError(text: string): void {
    this.notice = { kind: "error", text };
  }

  private clearShare(): void {
    this.shareSelection = null;
    this.sharePreviewState = null;
    this.shareResultState = null;
  }

  private clearHandoff(): void {
    this.pendingLinkedTask = null;
    this.taskLinkDraftState = null;
    this.taskLinkState = null;
    this.clearShare();
  }

  private async runTaskLinkConfirm(
    message: Extract<TeamChatWebviewMessage, { type: "taskLinkConfirm" }>,
  ): Promise<void> {
    const draft = this.taskLinkDraftState;
    const link = TaskLinkSchema.safeParse(draft?.link);
    if (
      !link.success ||
      link.data.link_id !== message.linkId ||
      link.data.requester_id !== this.me() ||
      link.data.conversation_id !== this.selected?.conversation.conversation_id
    )
      return;
    const client = this.options.workbench?.();
    const scope = client?.server?.scope;
    if (!client || !scope)
      return this.handoffError(
        "Connect to a MARS Workbench before creating the task.",
      );
    if (!this.service.taskLinkConfirm || !this.service.taskLinkCreated) return;
    if (!this.pendingLinkedTask) {
      const built = buildPendingTask(
        {
          request: message.request,
          acceptance_criteria: message.acceptanceCriteria,
          budget: message.budget,
        },
        scope,
        () => link.data.launch_key,
      );
      if (!built.ok) return this.handoffError(built.reason);
      this.pendingLinkedTask = {
        requestId: randomUUID(),
        task: {
          ...built.task,
          provenance: {
            source: "team_chat",
            conversation_id: link.data.conversation_id,
            message_ids: link.data.provenance.map(
              ({ message_id }) => message_id,
            ),
            reference_ids: link.data.reference_ids,
          },
        },
      };
    }
    const { task, requestId } = this.pendingLinkedTask;
    if (!sameScope(task.scope, scope))
      return this.handoffError(
        "Reconnect to the original Workbench to retry this task.",
      );
    const confirmed = await this.service.taskLinkConfirm(this.viewer, {
      link_id: message.linkId,
      workbench: { scope, task_id: task.task_id, request_id: requestId },
      target: {},
    });
    if (!confirmed.ok) return this.failed(confirmed.code);
    this.taskLinkState = { view: "requester", link: confirmed.value };
    let created: Task;
    try {
      created = await client.create(task, {
        launchKey: link.data.launch_key,
        requestId,
      });
    } catch {
      return this.handoffError(
        "Workbench did not acknowledge the task. Retry uses the same task and request.",
      );
    }
    const result = await this.service.taskLinkCreated(this.viewer, {
      link_id: message.linkId,
      task_revision: created.revision,
    });
    if (!result.ok) {
      this.failed(result.code);
      return;
    }
    this.notice = null;
    this.taskLinkDraftState = null;
    this.pendingLinkedTask = null;
    this.taskLinkState = { view: "requester", link: result.value };
  }

  private async runTaskLinkInspect(linkId: string): Promise<void> {
    if (!this.service.taskLinkInspect) return;
    const result = await this.service.taskLinkInspect(this.viewer, linkId);
    if (!result.ok) {
      this.failed(result.code);
      return;
    }
    if (
      result.value.link.conversation_id !==
      this.selected?.conversation.conversation_id
    )
      return;
    this.clearShare();
    this.taskLinkState = result.value;
  }

  private async linkedEvidence(linkId: string) {
    const view = this.taskLinkState;
    if (
      !view ||
      view.view !== "requester" ||
      view.link.link_id !== linkId ||
      view.link.requester_id !== this.me() ||
      view.link.conversation_id !==
        this.selected?.conversation.conversation_id ||
      (view.link.status !== "created" && view.link.status !== "shared")
    )
      return null;
    const link = TaskLinkSchema.safeParse(view.link);
    const binding = link.success ? link.data.workbench : null;
    const client = this.options.workbench?.();
    const scope = client?.server?.scope;
    if (!binding || !client || !scope || !sameScope(scope, binding.scope)) {
      this.handoffError(
        "Connect to this task's Workbench before sharing evidence.",
      );
      return null;
    }
    try {
      const task = await client.inspect(binding.task_id);
      const evidence = await client.evidence(binding.task_id);
      if (task.revision !== evidence.task_revision) {
        this.handoffError(
          "The task changed while loading evidence. Try again.",
        );
        return null;
      }
      return { evidence, run_status: task.status };
    } catch {
      this.handoffError("Could not load evidence from the task's Workbench.");
      return null;
    }
  }

  private async runSharePreview(
    message: Extract<TeamChatWebviewMessage, { type: "sharePreview" }>,
  ): Promise<void> {
    if (!this.service.sharePreview) {
      this.notice = {
        kind: "error",
        text: "Evidence sharing is not supported by this team service.",
      };
      return;
    }
    this.clearShare();
    const input = await this.linkedEvidence(message.linkId);
    if (!input) return;
    const selection = {
      summary: message.summary,
      include_diff_digest: message.includeDiffDigest,
      verify_event_ids: message.includeChecks
        ? input.evidence.verify_records
            .filter((record) => !record.stale)
            .slice(-SHARE_MAX_VERIFY_EVENT_IDS)
            .map((record) => record.event_id)
        : [],
    };
    const result = await this.service.sharePreview(this.viewer, {
      link_id: message.linkId,
      ...input,
      selection,
    });
    if (!result.ok) {
      this.failed(result.code);
      return;
    }
    this.notice = null;
    this.sharePreviewState = result.value;
    this.shareSelection = selection;
  }

  private async runShareCreate(
    message: Extract<TeamChatWebviewMessage, { type: "shareCreate" }>,
  ): Promise<void> {
    if (!this.service.shareCreate) {
      this.notice = {
        kind: "error",
        text: "Evidence sharing is not supported by this team service.",
      };
      return;
    }
    const preview = this.sharePreviewState;
    const selection = this.shareSelection;
    if (
      !preview ||
      !selection ||
      preview.card.link_id !== message.linkId ||
      preview.preview_sha256 !== message.previewSha256
    )
      return;
    const input = await this.linkedEvidence(message.linkId);
    if (!input) return;
    const result = await this.service.shareCreate(this.viewer, {
      link_id: message.linkId,
      ...input,
      selection,
      preview_sha256: preview.preview_sha256,
    });
    if (!result.ok) {
      if (result.code === "conflict" || result.code === "invalid") {
        this.clearShare();
        this.handoffError(
          "The evidence no longer matches the preview. Review a new preview before publishing.",
        );
      } else this.failed(result.code);
      return;
    }
    this.notice = null;
    this.clearShare();
    this.shareResultState = result.value;
    if (this.taskLinkState?.link.link_id === message.linkId) {
      this.taskLinkState = {
        ...this.taskLinkState,
        link: { ...this.taskLinkState.link, status: "shared" },
      };
    }
    if (this.selected) {
      await this.select(this.selected.conversation.conversation_id);
    }
  }

  private async switchViewer(userId: string): Promise<void> {
    if (this.service.label !== "FIXTURE") return;
    if (!this.service.users().some((u) => u.user_id === userId)) return;
    this.viewer = userId;
    this.clearPathSearch();
    this.selected = null;
    this.panel = null;
    this.notice = null;
    this.search = null;
    this.pending.splice(0, this.pending.length);
    this.pendingInputs.clear();
    this.pendingAgentRequests.clear();
    this.agentDraft = null;
    this.agentPreviewState = null;
    this.agentRequestState = null;
    await this.refreshInbox();
    const first = this.conversations[0];
    if (first) await this.select(first.conversation_id);
  }

  private announce(conversation: ConversationSummary, count: number): void {
    this.announcementSeq += 1;
    const where = conversation.title;
    this.announcement = {
      seq: this.announcementSeq,
      text:
        count === 1
          ? `New message in ${where}`
          : `${count} new messages in ${where}`,
    };
  }

  // ---------------------------------------------------------------- state

  snapshot(): TeamChatViewState {
    const users = this.service.users();
    const me = this.me();
    const viewer = users.find((u) => u.user_id === me) ?? {
      user_id: me,
      handle: me === this.viewer ? "unknown" : me,
      display_name: me === this.viewer ? "Unknown member" : me,
    };
    return {
      label: this.service.label,
      capabilities: { ...this.service.capabilities },
      connection: this.connection,
      viewer,
      viewers: this.service.label === "FIXTURE" ? users : [],
      conversations: this.conversations,
      selected: this.selected,
      pending: this.pending.map((p) => ({ ...p })),
      panel: this.panel,
      mention_index: this.service.mentionIndex(this.viewer),
      path_search: this.pathSearch,
      path_search_id: this.pathSearchId,
      agent_preview: this.agentPreviewState,
      agent_draft: this.agentDraft,
      agent_request: this.agentRequestState,
      task_link_draft: this.taskLinkDraftState,
      task_link_attempted: this.pendingLinkedTask !== null,
      task_link: this.taskLinkState,
      share_preview: this.sharePreviewState,
      share_result: this.shareResultState,
      notice: this.notice,
      search: this.search,
      announcement: this.announcement,
    };
  }

  private emit(): void {
    if (this.disposedFlag) return;
    this.options.post(this.snapshot());
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
