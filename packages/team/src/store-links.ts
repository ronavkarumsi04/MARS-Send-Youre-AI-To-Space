import {
  MessageSchema,
  type ResultCard,
  ResultCardSchema,
  SHARE_MAX_VERIFY_EVENT_IDS,
  type SharedEvidence,
  type SharedEvidenceRecord,
  type SharePreview,
  type ShareUnverifiedReason,
  TASK_LINK_MAX_MESSAGES,
  type TaskLink,
  TaskLinkSchema,
  TaskLinkSummarySchema,
  TEAM_MAX_EMOJI_CHARS,
  TEAM_MAX_EXCERPT_CHARS,
  TEAM_MAX_REFERENCES,
} from "@mars/contracts";
import { z } from "zod";
import {
  conflict,
  invalidInput,
  notFound,
  TeamError,
  unavailable,
} from "./errors";
import { TASK_LINK_EXCERPT_CHARS, TaskLinkDraftResultSchema } from "./protocol";
import type { ShareInput, TeamActor, TeamStore } from "./store";
import * as storeDb from "./store-db";
import { canonicalJson, idSchema, type MessageRow, sha256 } from "./store-db";
import { ENVELOPE_BYTES, type StoreScope } from "./store-scope";

const UNVERIFIED_REASON_ORDER: readonly ShareUnverifiedReason[] = [
  "missing",
  "stale",
  "failed",
  "inconclusive",
  "skipped",
];

/**
 * The only path to `verified: true`: a selected record the workbench marked
 * `verified && !stale` for this exact candidate. Everything else yields a
 * reason; the service never judges evidence itself.
 */
export function assessVerification(
  evidence: SharedEvidence,
  selected: SharedEvidenceRecord[],
): {
  verified: boolean;
  reason: ShareUnverifiedReason | null;
  evidence_event_id: string | null;
} {
  if (selected.length === 0)
    return { verified: false, reason: "missing", evidence_event_id: null };
  const fresh = (record: SharedEvidenceRecord) =>
    !record.stale &&
    record.diff_sha256 === evidence.diff_sha256 &&
    record.workspace_revision === evidence.workspace.revision;
  const proof = selected.find((record) => record.verified && fresh(record));
  if (proof)
    return { verified: true, reason: null, evidence_event_id: proof.event_id };
  const reasons = selected.map((record): ShareUnverifiedReason => {
    if (!fresh(record)) return "stale";
    if (record.verdict === "fail" || record.verdict === "error")
      return "failed";
    if (record.verdict === "inconclusive") return "inconclusive";
    return "skipped";
  });
  const reason =
    UNVERIFIED_REASON_ORDER.find((candidate) => reasons.includes(candidate)) ??
    "missing";
  const primary = selected[reasons.indexOf(reason)] ?? selected[0];
  return {
    verified: false,
    reason,
    evidence_event_id: primary?.event_id ?? null,
  };
}

/** `tasks.link_*` and `shares.*`: workbench task links and result cards. */
export function linkOperations(
  scope: StoreScope,
): Pick<
  TeamStore,
  | "linkDraft"
  | "linkConfirm"
  | "linkCreated"
  | "linkInspect"
  | "sharePreview"
  | "shareCreate"
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
    saveLink,
    requireLink,
    insertMessage,
    idempotent,
    messageRecord,
    storedMessageRow,
    write,
    read,
    takeSendSlot,
    messageView,
  } = scope;
  const linkRecordSchema: z.ZodType<TaskLink> = TaskLinkSchema;

  const buildCard = (
    actor: TeamActor,
    link: TaskLink,
    input: ShareInput,
  ): SharePreview => {
    if ((input.selection.artifacts?.length ?? 0) > 0)
      throw unavailable("Artifact shares are not available yet");
    if (link.status !== "created" && link.status !== "shared")
      throw conflict("Link has no workbench task yet");
    const ids = [...new Set(input.selection.verify_event_ids)];
    if (ids.length > SHARE_MAX_VERIFY_EVENT_IDS)
      throw invalidInput("Too many verify records");
    const selected = ids.map((eventId) => {
      const record = input.evidence.verify_records.find(
        (candidate) => candidate.event_id === eventId,
      );
      if (!record) throw invalidInput("Verify record is not in the evidence");
      return record;
    });
    const verdict = assessVerification(input.evidence, selected);
    const card: ResultCard = {
      link_id: link.link_id,
      requester_id: link.requester_id,
      attested_by: actor.user_id,
      summary: input.selection.summary,
      run_status: input.run_status,
      verified: verdict.verified,
      verified_reason: verdict.reason,
      task_revision: input.evidence.task_revision,
      workspace: input.evidence.workspace,
      diff_sha256: input.selection.include_diff_digest
        ? input.evidence.diff_sha256
        : null,
      evidence_event_id: verdict.evidence_event_id,
      evidence_sha256: sha256(canonicalJson(input.evidence)),
      verify_records: selected.map((record) => ({
        event_id: record.event_id,
        verdict: record.verdict,
        assurance: record.assurance,
        verified: record.verified,
        stale: record.stale,
        recorded_at: record.recorded_at,
      })),
      export_status: "not_exported",
      git_status: "unknown",
    };
    const parsed = ResultCardSchema.parse(card);
    return { preview_sha256: sha256(canonicalJson(parsed)), card: parsed };
  };
  return {
    linkDraft(actor, requestId, input) {
      return write(() => {
        requireTeamMember(actor);
        return idempotent(
          actor,
          requestId,
          "tasks.link_draft",
          input,
          TaskLinkDraftResultSchema,
          () => {
            const parsed = z
              .object({
                conversation_id: idSchema,
                message_ids: z
                  .array(idSchema)
                  .min(1)
                  .max(TASK_LINK_MAX_MESSAGES),
                reference_ids: z.array(idSchema).max(TEAM_MAX_REFERENCES),
              })
              .strict()
              .safeParse(input);
            if (!parsed.success) throw invalidInput("Invalid task link input");
            const { conversation, participant } = requireParticipant(
              actor,
              parsed.data.conversation_id,
            );
            const rows: MessageRow[] = [];
            for (const messageId of new Set(parsed.data.message_ids)) {
              const row = db
                .query<MessageRow, [string, string]>(
                  "SELECT * FROM messages WHERE message_id = ? AND conversation_id = ?",
                )
                .get(messageId, conversation.conversation_id);
              if (!row || row.seq <= participant.joined_seq)
                throw invalidInput("Message is not in this conversation");
              rows.push(row);
            }
            rows.sort((a, b) => a.seq - b.seq);
            const at = timestamp();
            const linkId = randomId();
            const link: TaskLink = TaskLinkSchema.parse({
              link_id: linkId,
              team_id: actor.team_id,
              conversation_id: conversation.conversation_id,
              requester_id: actor.user_id,
              launch_key: `tc-${sha256(canonicalJson([actor.team_id, linkId])).slice(0, 48)}`,
              provenance: rows.map((row) => ({
                message_id: row.message_id,
                seq: row.seq,
                body_sha256: row.body_sha256,
              })),
              reference_ids: [...new Set(parsed.data.reference_ids)],
              target: null,
              workbench: null,
              task_revision: null,
              status: "draft",
              created_at: at,
              updated_at: at,
            });
            saveLink(link, true);
            return TaskLinkDraftResultSchema.parse({
              link,
              excerpts: rows.map((row) => {
                const body = row.deleted === 1 ? "" : row.body;
                const chars = Array.from(body);
                return {
                  message_id: row.message_id,
                  seq: row.seq,
                  author_id: row.author_id,
                  excerpt: chars.slice(0, TASK_LINK_EXCERPT_CHARS).join(""),
                  truncated: chars.length > TASK_LINK_EXCERPT_CHARS,
                };
              }),
            });
          },
        );
      });
    },
    linkConfirm(actor, requestId, input) {
      return write(() => {
        requireTeamMember(actor);
        return idempotent(
          actor,
          requestId,
          "tasks.link_confirm",
          input,
          linkRecordSchema,
          () => {
            const { link } = requireLink(actor, input.link_id, true);
            const workbench = TaskLinkSchema.shape.workbench
              .unwrap()
              .safeParse(input.workbench);
            if (!workbench.success)
              throw invalidInput("Invalid workbench binding");
            const target = {
              repo_id: input.target.repo_id ?? null,
              base_revision: input.target.base_revision ?? null,
            };
            if (link.status !== "draft") {
              // An interrupted confirm retried with a new request id resolves to
              // the same link only when it names the same workbench task.
              if (
                link.workbench !== null &&
                canonicalJson(link.workbench) ===
                  canonicalJson(workbench.data) &&
                canonicalJson(link.target) === canonicalJson(target)
              )
                return link;
              throw conflict("Link is already bound to a workbench task");
            }
            const confirmed = TaskLinkSchema.parse({
              ...link,
              workbench: workbench.data,
              target,
              status: "confirmed",
              updated_at: timestamp(),
            });
            saveLink(confirmed, false);
            metrics.increment("links");
            return confirmed;
          },
        );
      });
    },
    linkCreated(actor, requestId, input) {
      return write(() => {
        requireTeamMember(actor);
        return idempotent(
          actor,
          requestId,
          "tasks.link_created",
          input,
          linkRecordSchema,
          () => {
            if (
              !Number.isInteger(input.task_revision) ||
              input.task_revision < 0
            )
              throw invalidInput("Invalid task revision");
            const { link } = requireLink(actor, input.link_id, true);
            if (
              link.status !== "confirmed" &&
              link.status !== "created" &&
              link.status !== "shared"
            )
              throw conflict("Link is not awaiting workbench creation");
            if (
              link.task_revision !== null &&
              input.task_revision < link.task_revision
            )
              throw conflict("Task revision moved backwards");
            if (link.task_revision === input.task_revision) return link;
            const created = TaskLinkSchema.parse({
              ...link,
              task_revision: input.task_revision,
              status: link.status === "shared" ? "shared" : "created",
              updated_at: timestamp(),
            });
            saveLink(created, false);
            return created;
          },
        );
      });
    },
    linkInspect(actor, linkId) {
      return read(() => {
        requireTeamMember(actor);
        const { link } = requireLink(actor, linkId, false);
        if (link.requester_id === actor.user_id)
          return { view: "requester" as const, link };
        const {
          launch_key: _key,
          target: _target,
          workbench: _wb,
          ...rest
        } = link;
        return {
          view: "member" as const,
          link: TaskLinkSummarySchema.parse(rest),
        };
      });
    },
    sharePreview(actor, input) {
      return read(() => {
        requireTeamMember(actor);
        const { link } = requireLink(actor, input.link_id, true);
        return buildCard(actor, link, input);
      });
    },
    shareCreate(actor, requestId, input) {
      return write(() => {
        requireTeamMember(actor);
        takeSendSlot(actor);
        // The idempotent replay carries the bytes as first posted; the
        // stale/superseded overlay is re-read so a retry agrees with history.
        const posted = idempotent(
          actor,
          requestId,
          "shares.create",
          input,
          MessageSchema,
          () => {
            const { link, conversation } = requireLink(
              actor,
              input.link_id,
              true,
            );
            const { preview_sha256, ...rest } = input;
            const preview = buildCard(actor, link, rest);
            if (preview.preview_sha256 !== preview_sha256)
              throw conflict("Preview digest does not match the card");
            if (Buffer.byteLength(preview.card.summary) > limits.max_body_bytes)
              throw new TeamError(
                "too_large",
                "Message body exceeds the size limit",
              );
            const seq = storeDb.nextMessageSeq(conversation);
            const shareId = randomId();
            const at = timestamp();
            const record = insertMessage(conversation, {
              message_id: randomId(),
              conversation_id: conversation.conversation_id,
              author_id: actor.user_id,
              kind: "result_card",
              agent_request_id: null,
              seq,
              client_message_id: `share:${shareId}`,
              body: preview.card.summary,
              body_sha256: sha256(preview.card.summary),
              reply_to: null,
              reference_ids: [],
              created_at: at,
              edited_at: null,
              deleted: false,
            });
            const stored = {
              share_id: shareId,
              link_id: link.link_id,
              message_id: record.message_id,
              message_seq: seq,
              preview_sha256: preview.preview_sha256,
              candidate_diff_sha256: input.evidence.diff_sha256,
              evidence_sha256: preview.card.evidence_sha256,
              card_json: canonicalJson(preview.card),
              created_at: at,
            };
            metrics.increment("shares");
            db.query(
              "INSERT INTO result_shares (share_id, link_id, message_id, message_seq, preview_sha256, candidate_diff_sha256, evidence_sha256, card_json, created_at, record_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ).run(
              stored.share_id,
              stored.link_id,
              stored.message_id,
              stored.message_seq,
              stored.preview_sha256,
              stored.candidate_diff_sha256,
              stored.evidence_sha256,
              stored.card_json,
              stored.created_at,
              sha256(canonicalJson(stored)),
            );
            if (link.status !== "shared")
              saveLink(
                TaskLinkSchema.parse({
                  ...link,
                  status: "shared",
                  updated_at: at,
                }),
                false,
              );
            const message = messageRecord(storedMessageRow(record.message_id));
            // A card must stay readable through messages.history even once the
            // overlay marks it stale and every reaction key is in use: the
            // history item (`MessageView`) at its ceiling is what is measured.
            const worstCase = {
              ...message,
              references: message.reference_ids.map((referenceId) => ({
                reference_id: referenceId,
                restricted: false,
                repo_id: "\uffff".repeat(256),
                commit_sha: "f".repeat(40),
                path: "\uffff".repeat(1024),
                line_start: Number.MAX_SAFE_INTEGER,
                line_end: Number.MAX_SAFE_INTEGER,
              })),
              payload: message.payload && {
                ...message.payload,
                stale: true,
                superseded_by: message.message_id,
              },
              reactions: Array.from(
                { length: limits.max_reactions_per_message },
                () => ({
                  emoji: "\uffff".repeat(TEAM_MAX_EMOJI_CHARS),
                  count: Number.MAX_SAFE_INTEGER,
                  reacted: true,
                }),
              ),
              reply_excerpt:
                message.reply_to === null
                  ? null
                  : "\uffff".repeat(TEAM_MAX_EXCERPT_CHARS),
              reply_restricted: false,
            };
            if (
              Buffer.byteLength(JSON.stringify(worstCase)) + ENVELOPE_BYTES >
              limits.max_page_bytes
            )
              throw new TeamError(
                "too_large",
                "Result card exceeds the page size",
              );
            return message;
          },
        );
        const viewed = messageRecord(storedMessageRow(posted.message_id));
        const viewer = participantRow(viewed.conversation_id, actor.user_id);
        if (!viewer) throw notFound();
        return messageView(actor, storedMessageRow(viewed.message_id), viewer);
      });
    },
  };
}
