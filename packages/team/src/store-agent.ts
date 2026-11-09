import {
  AGENT_MAX_IDEMPOTENCY_KEY_CHARS,
  AGENT_MAX_MESSAGES,
  type AgentCitation,
  type AgentPreview,
  type AgentPreviewItem,
  AgentPreviewSchema,
  type AgentRequest,
  AgentRequestSchema,
  MARS_AGENT_USER_ID,
  TEAM_MAX_REFERENCES,
} from "@mars/contracts";
import { z } from "zod";
import {
  AGENT_REASON_CODE,
  type AgentCompletion,
  type AgentFrozenInput,
  AgentFrozenInputSchema,
  type ClaimedAgentRequest,
  type TeamAgentHostPort,
  type TeamAgentOptions,
} from "./agent";
import { conflict, invalidInput, notFound, TeamError } from "./errors";
import { isTeamMetricCounter } from "./metrics";
import type { TeamActor, TeamStore } from "./store";
import * as storeDb from "./store-db";
import {
  type ConversationRow,
  canonicalJson,
  idSchema,
  type MessageRow,
  sha256,
} from "./store-db";
import type { StoreScope } from "./store-scope";

interface AgentRequestRow {
  request_id: string;
  team_id: string;
  conversation_id: string;
  requester_id: string;
  idempotency_key: string;
  params_sha256: string;
  status: string;
  cancel_requested: number;
  anchor_seq: number;
  input_json: string;
  input_sha256: string;
  record_json: string;
  record_sha256: string;
  answer_body: string | null;
  created_seq: number;
}

/** @MARS requests: queued here, executed by the workbench through `agentHost`. */
export function agentOperations(
  scope: StoreScope,
): Pick<
  TeamStore,
  "agentHost" | "agentPreview" | "agentRequest" | "agentCancel" | "agentInspect"
> {
  const {
    db,
    limits,
    randomId,
    agentOptions,
    timestamp,
    metrics,
    ctx,
    readEnabled,
    requireTeamMember,
    conversationRow,
    participantRow,
    requireParticipant,
    insertMessage,
    messageRecord,
    write,
    read,
    takeAgentSlot,
  } = scope;
  // ---------------------------------------------------------------------------
  // @MARS requests: queued here, executed by the workbench (never a model call).
  // ---------------------------------------------------------------------------
  const requireAgent = (): TeamAgentOptions => {
    if (!agentOptions)
      throw new TeamError("unavailable", "Agent requests are not enabled");
    return agentOptions;
  };
  const activeParticipants = (conversationId: string): string[] =>
    db
      .query<{ user_id: string }, [string]>(
        "SELECT user_id FROM participants WHERE conversation_id = ? AND state = 'active' ORDER BY user_id",
      )
      .all(conversationId)
      .map((row) => row.user_id);
  const selectionSchema = z
    .object({
      conversation_id: idSchema,
      message_ids: z.array(idSchema).max(AGENT_MAX_MESSAGES),
      reference_ids: z.array(idSchema).max(TEAM_MAX_REFERENCES),
    })
    .strict();
  interface ReferenceSnapshot {
    reference_id: string;
    label: string;
    text: string;
    readers: string[];
  }
  const describeReferences = (
    agent: TeamAgentOptions,
    teamId: string,
    referenceIds: readonly string[],
    viewers: readonly string[],
  ): ReferenceSnapshot[] => {
    if (referenceIds.length === 0) return [];
    if (!agent.references)
      throw invalidInput("References are not available to agent requests");
    const described = new Map(
      agent.references
        .describe({ team_id: teamId, reference_ids: referenceIds, viewers })
        .map((entry) => [entry.reference_id, entry] as const),
    );
    return referenceIds.map((referenceId) => {
      const entry = described.get(referenceId);
      const readers = entry
        ? [...new Set(entry.readers.filter((v) => viewers.includes(v)))].sort()
        : [];
      const text = entry?.text ?? "";
      if (Buffer.byteLength(text) > limits.max_reference_excerpt_bytes)
        throw new TeamError(
          "too_large",
          "A reference excerpt exceeds the agent context limit",
        );
      return {
        reference_id: referenceId,
        label: entry?.label ?? "",
        text,
        readers,
      };
    });
  };
  const referenceAccessDigest = (snapshots: readonly ReferenceSnapshot[]) =>
    sha256(
      canonicalJson(
        snapshots.map((entry) => ({
          reference_id: entry.reference_id,
          readers: entry.readers,
        })),
      ),
    );
  /** Authorizes, freezes and digests a selection inside the caller's transaction. */
  const buildPreview = (
    actor: TeamActor,
    rawInput: unknown,
  ): {
    preview: AgentPreview;
    conversation: ConversationRow;
    frozen: AgentFrozenInput;
  } => {
    const agent = requireAgent();
    const parsed = selectionSchema.safeParse(rawInput);
    if (!parsed.success) throw invalidInput("Invalid agent selection");
    const input = parsed.data;
    const { conversation, participant } = requireParticipant(
      actor,
      input.conversation_id,
    );
    if (
      new Set(input.message_ids).size !== input.message_ids.length ||
      new Set(input.reference_ids).size !== input.reference_ids.length
    )
      throw invalidInput("Selection contains duplicates");
    if (input.message_ids.length + input.reference_ids.length === 0)
      throw invalidInput("Selection is empty");
    const rows = input.message_ids.map((messageId) => {
      const row = db
        .query<MessageRow, [string, string]>(
          "SELECT * FROM messages WHERE message_id = ? AND conversation_id = ?",
        )
        .get(messageId, conversation.conversation_id);
      if (!row || row.seq <= participant.joined_seq || row.deleted === 1)
        throw invalidInput("Selection includes an unavailable message");
      return messageRecord(row);
    });
    rows.sort((a, b) => a.seq - b.seq);
    const participants = activeParticipants(conversation.conversation_id);
    const references = describeReferences(
      agent,
      actor.team_id,
      [...input.reference_ids].sort(),
      participants,
    );
    const scan = agent.scan ?? (() => undefined);
    const frozen: AgentFrozenInput = {
      messages: rows.map((message) => ({
        message_id: message.message_id,
        seq: message.seq,
        author_id: message.author_id,
        created_at: message.created_at,
        body: message.body,
        body_sha256: message.body_sha256,
        flagged: scan(message.body) ?? null,
      })),
      // A reference someone in the audience cannot read contributes nothing
      // but its id: no label, text, size or threat flag leaves the gate.
      references: references.map((entry) =>
        entry.readers.length === participants.length
          ? {
              reference_id: entry.reference_id,
              label: entry.label,
              text: entry.text,
              bytes: Buffer.byteLength(entry.text),
              flagged: scan(entry.text) ?? scan(entry.label) ?? null,
            }
          : {
              reference_id: entry.reference_id,
              label: "",
              text: "",
              bytes: 0,
              flagged: null,
            },
      ),
      participants,
      reference_access_sha256: referenceAccessDigest(references),
    };
    const items: AgentPreviewItem[] = [
      ...frozen.messages.map((message) => ({
        kind: "message" as const,
        message_id: message.message_id,
        seq: message.seq,
        body_sha256: message.body_sha256,
        bytes: Buffer.byteLength(message.body),
        flagged: message.flagged,
      })),
      ...frozen.references.map((entry) => ({
        kind: "reference" as const,
        reference_id: entry.reference_id,
        bytes: entry.bytes,
        flagged: entry.flagged,
      })),
    ];
    const total = items.reduce((sum, item) => sum + item.bytes, 0);
    if (total > limits.max_agent_context_bytes)
      throw new TeamError(
        "too_large",
        "Selection exceeds the agent context limit",
      );
    const unsigned = {
      conversation_id: conversation.conversation_id,
      audience: "conversation" as const,
      items,
      participant_count: participants.length,
      restricted_reference_ids: references
        .filter((entry) => entry.readers.length !== participants.length)
        .map((entry) => entry.reference_id),
      model: agent.model(),
    };
    const preview = AgentPreviewSchema.parse({
      ...unsigned,
      preview_sha256: sha256(canonicalJson(unsigned)),
    });
    return { preview, conversation, frozen };
  };
  const agentRow = (requestId: string): AgentRequestRow | null =>
    idSchema.safeParse(requestId).success
      ? db
          .query<AgentRequestRow, [string]>(
            "SELECT * FROM agent_requests WHERE request_id = ?",
          )
          .get(requestId)
      : null;
  const agentRecord = (row: AgentRequestRow): AgentRequest => {
    if (sha256(row.record_json) !== row.record_sha256)
      throw new TeamError("corrupt_record", "Stored agent request is invalid");
    const parsed = AgentRequestSchema.safeParse(JSON.parse(row.record_json));
    if (!parsed.success)
      throw new TeamError("corrupt_record", "Stored agent request is invalid");
    return parsed.data;
  };
  const frozenInput = (row: AgentRequestRow): AgentFrozenInput => {
    if (sha256(row.input_json) !== row.input_sha256)
      throw new TeamError("corrupt_record", "Stored agent input is invalid");
    const parsed = AgentFrozenInputSchema.safeParse(JSON.parse(row.input_json));
    if (!parsed.success)
      throw new TeamError("corrupt_record", "Stored agent input is invalid");
    return parsed.data;
  };
  const countAgentStatus = (status: string) => {
    const name = `agent_requests.${status}`;
    if (isTeamMetricCounter(name)) metrics.increment(name);
  };
  const saveAgentRecord = (
    row: AgentRequestRow,
    record: AgentRequest,
    extra: { cancel_requested?: boolean; answer_body?: string | null } = {},
  ): AgentRequest => {
    const next = AgentRequestSchema.parse({
      ...record,
      updated_at: timestamp(),
    });
    const json = canonicalJson(next);
    if (next.status !== row.status) countAgentStatus(next.status);
    db.query(
      "UPDATE agent_requests SET status = ?, record_json = ?, record_sha256 = ?, cancel_requested = ?, answer_body = ? WHERE request_id = ?",
    ).run(
      next.status,
      json,
      sha256(json),
      (extra.cancel_requested ?? row.cancel_requested === 1) ? 1 : 0,
      extra.answer_body === undefined ? row.answer_body : extra.answer_body,
      row.request_id,
    );
    return next;
  };
  const cancelControllers = new Map<string, AbortController>();
  const requireAgentViewer = (
    actor: TeamActor,
    requestId: string,
  ): AgentRequestRow => {
    const row = agentRow(requestId);
    if (!row || row.team_id !== actor.team_id) throw notFound();
    if (row.requester_id !== actor.user_id) {
      // Only participants who could see the selected messages may see the
      // request: a later joiner (`joined_seq` at or past the anchor) cannot.
      const participant = participantRow(row.conversation_id, actor.user_id);
      if (
        !participant ||
        participant.state !== "active" ||
        participant.joined_seq >= row.anchor_seq
      )
        throw notFound();
    }
    return row;
  };
  const completionSchema = z
    .object({
      answer_body: z.string(),
      citations: z.array(
        z.discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("message"),
              message_id: idSchema,
              seq: z.number().int().positive(),
            })
            .strict(),
          z
            .object({ kind: z.literal("reference"), reference_id: idSchema })
            .strict(),
        ]),
      ),
      dropped_citations: z.number().int().nonnegative().optional(),
      evidence: z.unknown().optional(),
    })
    .strict();
  const requireRunning = (requestId: string): AgentRequestRow => {
    const row = agentRow(requestId);
    if (!row) throw notFound();
    if (row.status !== "running")
      throw conflict("Agent request is not running");
    return row;
  };
  const finish = (
    row: AgentRequestRow,
    record: AgentRequest,
    status: AgentRequest["status"],
    reasonCode: string | null,
    extra: { answer_body?: string | null } = {},
  ): AgentRequest => {
    cancelControllers.delete(row.request_id);
    return saveAgentRecord(
      row,
      { ...record, status, reason_code: reasonCode },
      extra,
    );
  };
  const agentHost: TeamAgentHostPort = {
    claimNext() {
      return write((): ClaimedAgentRequest | null => {
        if (!readEnabled()) return null;
        const row = db
          .query<AgentRequestRow, []>(
            "SELECT * FROM agent_requests WHERE status = 'pending' ORDER BY created_seq LIMIT 1",
          )
          .get();
        if (!row) return null;
        const record = saveAgentRecord(row, {
          ...agentRecord(row),
          status: "running",
        });
        const controller = new AbortController();
        cancelControllers.set(row.request_id, controller);
        return {
          request: record,
          input: frozenInput(row),
          signal: controller.signal,
        };
      });
    },
    complete(requestId, completion: AgentCompletion) {
      return write(() => {
        const row = requireRunning(requestId);
        const record = agentRecord(row);
        const parsed = completionSchema.safeParse(completion);
        if (!parsed.success) throw invalidInput("Invalid agent completion");
        if (row.cancel_requested === 1)
          return finish(row, record, "cancelled", "cancelled");
        const body = parsed.data.answer_body;
        if (
          body.trim().length === 0 ||
          Buffer.byteLength(body) > limits.max_body_bytes
        )
          return finish(row, record, "failed", "answer_too_large");
        const frozen = frozenInput(row);
        const known = new Set(
          frozen.messages.map((m) => `${m.message_id}@${m.seq}`),
        );
        const knownReferences = new Set(
          frozen.references.map((r) => r.reference_id),
        );
        const citations: AgentCitation[] = [];
        let dropped = parsed.data.dropped_citations ?? 0;
        for (const citation of parsed.data.citations) {
          const ok =
            citation.kind === "message"
              ? known.has(`${citation.message_id}@${citation.seq}`)
              : knownReferences.has(citation.reference_id);
          if (ok) citations.push(citation);
          else dropped += 1;
        }
        const conversation = conversationRow(row.conversation_id);
        if (!conversation)
          throw new TeamError("corrupt_record", "Conversation missing");
        const participants = activeParticipants(conversation.conversation_id);
        const sameAudience =
          participants.length === frozen.participants.length &&
          participants.every((user, i) => user === frozen.participants[i]);
        const withResult = {
          ...record,
          citations,
          dropped_citations: dropped,
        };
        if (!sameAudience)
          return finish(row, withResult, "restricted", "audience_changed", {
            answer_body: body,
          });
        if (frozen.references.length > 0) {
          const agent = requireAgent();
          const current = describeReferences(
            agent,
            row.team_id,
            frozen.references.map((r) => r.reference_id),
            participants,
          );
          if (referenceAccessDigest(current) !== frozen.reference_access_sha256)
            return finish(
              row,
              withResult,
              "restricted",
              "reference_access_changed",
              { answer_body: body },
            );
        }
        const message = insertMessage(conversation, {
          message_id: randomId(),
          conversation_id: conversation.conversation_id,
          author_id: MARS_AGENT_USER_ID,
          kind: "agent",
          agent_request_id: row.request_id,
          seq: storeDb.nextMessageSeq(conversation),
          client_message_id: `agent:${row.request_id}`,
          body,
          body_sha256: sha256(body),
          reply_to: null,
          reference_ids: [
            ...new Set(
              citations.flatMap((c) =>
                c.kind === "reference" ? [c.reference_id] : [],
              ),
            ),
          ],
          created_at: timestamp(),
          edited_at: null,
          deleted: false,
        });
        return finish(
          row,
          {
            ...withResult,
            answer: { message_id: message.message_id, evidence: null },
          },
          "completed",
          null,
          { answer_body: body },
        );
      });
    },
    recover() {
      return write(() => {
        const rows = db
          .query<AgentRequestRow, []>(
            "SELECT * FROM agent_requests WHERE status = 'running' ORDER BY created_seq",
          )
          .all()
          .filter((row) => !cancelControllers.has(row.request_id));
        for (const row of rows)
          finish(
            row,
            agentRecord(row),
            row.cancel_requested === 1 ? "cancelled" : "failed",
            row.cancel_requested === 1 ? "cancelled" : "worker_lost",
          );
        return rows.length;
      });
    },
    fail(requestId, reasonCode) {
      if (!AGENT_REASON_CODE.test(reasonCode))
        throw invalidInput("Invalid agent failure reason");
      return write(() => {
        const row = requireRunning(requestId);
        const record = agentRecord(row);
        return row.cancel_requested === 1 || reasonCode === "cancelled"
          ? finish(row, record, "cancelled", "cancelled")
          : finish(row, record, "failed", reasonCode);
      });
    },
  };
  return {
    agentHost,
    agentPreview(actor, input) {
      return read(() => {
        requireTeamMember(actor);
        takeAgentSlot(actor);
        return buildPreview(actor, input).preview;
      });
    },
    agentRequest(actor, input) {
      return write(() => {
        requireTeamMember(actor);
        requireAgent();
        takeAgentSlot(actor);
        const parsed = z
          .object({
            idempotency_key: z
              .string()
              .min(1)
              .max(AGENT_MAX_IDEMPOTENCY_KEY_CHARS),
            conversation_id: idSchema,
            message_ids: z.array(idSchema).max(AGENT_MAX_MESSAGES),
            reference_ids: z.array(idSchema).max(TEAM_MAX_REFERENCES),
            audience: z.literal("conversation"),
            preview_sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict()
          .safeParse(input);
        if (!parsed.success) throw invalidInput("Invalid agent request");
        const paramsHash = sha256(canonicalJson(parsed.data));
        const existing = db
          .query<AgentRequestRow, [string, string, string]>(
            "SELECT * FROM agent_requests WHERE team_id = ? AND requester_id = ? AND idempotency_key = ?",
          )
          .get(actor.team_id, actor.user_id, parsed.data.idempotency_key);
        if (existing) {
          if (existing.params_sha256 !== paramsHash)
            throw conflict("Idempotency key was reused with different input");
          return agentRecord(existing);
        }
        const { preview, conversation, frozen } = buildPreview(actor, {
          conversation_id: parsed.data.conversation_id,
          message_ids: parsed.data.message_ids,
          reference_ids: parsed.data.reference_ids,
        });
        if (preview.preview_sha256 !== parsed.data.preview_sha256)
          throw conflict("Preview digest does not match the current selection");
        if (preview.restricted_reference_ids.length > 0)
          throw new TeamError(
            "forbidden",
            "Not every participant may read the selected references",
          );
        const at = timestamp();
        const record = AgentRequestSchema.parse({
          request_id: randomId(),
          team_id: actor.team_id,
          conversation_id: conversation.conversation_id,
          requester_id: actor.user_id,
          idempotency_key: parsed.data.idempotency_key,
          audience: "conversation",
          messages: frozen.messages.map((m) => ({
            message_id: m.message_id,
            seq: m.seq,
            body_sha256: m.body_sha256,
          })),
          reference_ids: frozen.references.map((r) => r.reference_id),
          preview_sha256: preview.preview_sha256,
          model_id: preview.model.model_id,
          status: "pending",
          flagged: [
            ...frozen.messages.flatMap((m) =>
              m.flagged
                ? [
                    {
                      kind: "message" as const,
                      message_id: m.message_id,
                      threat: m.flagged,
                    },
                  ]
                : [],
            ),
            ...frozen.references.flatMap((r) =>
              r.flagged
                ? [
                    {
                      kind: "reference" as const,
                      reference_id: r.reference_id,
                      threat: r.flagged,
                    },
                  ]
                : [],
            ),
          ],
          citations: [],
          dropped_citations: 0,
          reason_code: null,
          answer: null,
          created_at: at,
          updated_at: at,
        } satisfies AgentRequest);
        const anchorSeq =
          frozen.messages.length > 0
            ? Math.min(...frozen.messages.map((m) => m.seq))
            : conversation.last_seq + 1;
        const inputJson = canonicalJson(frozen);
        const recordJson = canonicalJson(record);
        const createdSeq = storeDb.nextCreatedSeq(ctx, "agent_requests");
        metrics.increment("agent_requests.pending");
        db.query(
          "INSERT INTO agent_requests (request_id, team_id, conversation_id, requester_id, idempotency_key, params_sha256, status, cancel_requested, anchor_seq, input_json, input_sha256, record_json, record_sha256, answer_body, created_seq) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?, NULL, ?)",
        ).run(
          record.request_id,
          record.team_id,
          record.conversation_id,
          record.requester_id,
          record.idempotency_key,
          paramsHash,
          anchorSeq,
          inputJson,
          sha256(inputJson),
          recordJson,
          sha256(recordJson),
          createdSeq,
        );
        return record;
      });
    },
    agentCancel(actor, input) {
      return write(() => {
        requireTeamMember(actor);
        const row = agentRow(input?.request_id);
        if (
          !row ||
          row.team_id !== actor.team_id ||
          row.requester_id !== actor.user_id
        )
          throw notFound();
        const record = agentRecord(row);
        if (row.status === "pending")
          return finish(row, record, "cancelled", "cancelled");
        if (row.status === "running") {
          const next = saveAgentRecord(row, record, { cancel_requested: true });
          cancelControllers.get(row.request_id)?.abort();
          return next;
        }
        return record;
      });
    },
    agentInspect(actor, input) {
      return read(() => {
        requireTeamMember(actor);
        return agentRecord(requireAgentViewer(actor, input?.request_id));
      });
    },
  };
}
