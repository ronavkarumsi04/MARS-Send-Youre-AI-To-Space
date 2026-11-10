import {
  ArtifactRefSchema,
  EventEnvelopeSchema,
  type RequestContext,
  SCHEMA_VERSION,
  type Scope,
  ScopeSchema,
  TaskSchema,
  VerificationViewSchema,
  WorkbenchDescribeFields,
  WorkbenchInspectFields,
} from "@mars/contracts";
import { z } from "zod";

const id = z.string().min(1);

/**
 * Wire schemas for the frozen workbench RPC protocol. `WorkspaceRef` and
 * `CheckpointRef` are interfaces in @mars/contracts without runtime schemas,
 * so they are validated here against the same shapes.
 */
export const WorkspaceRefSchema = z
  .object({ workspace_id: id, provider: id, revision: id })
  .strict();

export const CheckpointRefSchema = z
  .object({
    checkpoint_id: id,
    workspace: WorkspaceRefSchema,
    artifact: ArtifactRefSchema,
  })
  .strict();

export const DescribeResultSchema = z
  .object({
    ...WorkbenchDescribeFields,
    scope: ScopeSchema,
    workspaceLabel: z.string().min(1).max(200),
    capabilities: z
      .object({ execute: z.boolean(), checkpoint: z.boolean() })
      .strict(),
  })
  .strict();
export type DescribeResult = z.infer<typeof DescribeResultSchema>;
export const InspectResultSchema = TaskSchema.extend(
  WorkbenchInspectFields,
).strict();

export const ApprovalsSchema = z
  .object({ read: z.boolean(), write: z.boolean(), execute: z.boolean() })
  .strict();
export type Approvals = z.infer<typeof ApprovalsSchema>;

export const ArtifactDataSchema = z
  .object({
    data_base64: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/),
    media_type: id,
  })
  .strict();
export type ArtifactData = z.infer<typeof ArtifactDataSchema>;

export const DiffFileSchema = z
  .object({
    path: z.string().min(1).max(4096),
    status: z.enum(["added", "modified", "deleted"]),
    patch: z.string(),
  })
  .strict();
export type DiffFile = z.infer<typeof DiffFileSchema>;

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * `digest` is the canonical SHA-256 of the diff (server `diffDigest`). It is
 * an additive change to the frozen protocol and stays optional so a
 * result from an older server still validates.
 */
export const DiffResultSchema = z
  .object({
    files: z.array(DiffFileSchema).max(5000),
    digest: sha256Hex.optional(),
  })
  .strict();
export type DiffResult = z.infer<typeof DiffResultSchema>;

export const LAUNCH_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export const EvidenceRecordSchema = z
  .object({
    event_id: id,
    verdict: z.enum(["pass", "fail", "inconclusive", "error"]),
    assurance: z.enum([
      "none",
      "visual_advisory",
      "deterministic_local",
      "isolated_local",
      "remote_attested",
    ]),
    verified: z.boolean(),
    contract_id: id.optional(),
    contract_digest: z.string().min(1).max(256).optional(),
    recorded_at: z.string().datetime(),
    workspace_id: id.nullable(),
    workspace_revision: id.nullable(),
    diff_sha256: sha256Hex.nullable(),
    stale: z.boolean(),
    binding_error: z
      .string()
      .regex(/^[A-Za-z0-9_.-]{1,64}$/)
      .optional(),
  })
  .strict()
  .refine((record) => !record.verified || record.verdict === "pass", {
    message: "Only a passed verdict may be verified",
  });
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

export const EvidenceResultSchema = z
  .object({
    task_revision: z.number().int().nonnegative(),
    workspace: WorkspaceRefSchema,
    diff_sha256: sha256Hex,
    verify_records: z.array(EvidenceRecordSchema).max(1000),
    host_verification: VerificationViewSchema.optional(),
  })
  .strict();
export type EvidenceResult = z.infer<typeof EvidenceResultSchema>;

export const RpcErrorSchema = z
  .object({ code: z.string().min(1).max(200), message: z.string() })
  .strict();

export const NullResultSchema = z.null();

export const RPC_METHODS = {
  describe: "workbench.describe",
  create: "tasks.create",
  list: "tasks.list",
  inspect: "tasks.inspect",
  journal: "tasks.journal",
  start: "tasks.start",
  resume: "tasks.resume",
  steer: "tasks.steer",
  cancel: "tasks.cancel",
  events: "tasks.events",
  artifact: "tasks.artifact",
  diff: "tasks.diff",
  evidence: "tasks.evidence",
  checkpoint: "tasks.checkpoint",
  restore: "tasks.restore",
  verification: "tasks.verification",
  export: "tasks.export",
  skills: "skills.list",
  skillProposals: "skills.proposals.list",
  acceptSkillProposal: "skills.proposals.accept",
  rejectSkillProposal: "skills.proposals.reject",
  undoSkillReview: "skills.reviews.undo",
} as const;
export type RpcMethod = (typeof RPC_METHODS)[keyof typeof RPC_METHODS];

export const SkillViewSchema = z
  .object({
    name: z.string().min(1).max(128),
    status: z.enum(["active", "stale", "archived"]),
    pinned: z.boolean(),
    content: z.string(),
    use_count: z.number().int().nonnegative(),
    last_activity: z.number().int().nonnegative(),
    outcomes: z
      .object({
        loads: z.number().int().nonnegative(),
        verified: z.number().int().nonnegative(),
        baseline_rate: z.number().min(0).max(1),
        baseline_loads: z.number().int().nonnegative(),
        helpfulness: z.number().min(-1).max(1),
        quarantined: z.boolean(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type SkillView = z.infer<typeof SkillViewSchema>;
export const SkillListSchema = z.array(SkillViewSchema).max(10_000);
export const SkillProposalViewSchema = z
  .object({
    proposal_id: z.string().min(1).max(256),
    source: z.string().min(1),
    review_id: z.string().min(1).max(256).nullable(),
    rationale: z.string(),
    status: z.enum(["pending", "accepted", "rejected"]),
    reason: z.string().optional(),
    operations: z
      .array(
        z
          .object({
            op: z.string().min(1).max(64),
            name: z.string().min(1).max(128),
            content: z.string().optional(),
            pinned: z.boolean().optional(),
            version_id: z.string().min(1).max(256).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(1024),
    gate: z
      .object({
        required: z.boolean(),
        cleared: z.boolean(),
        summary: z.string().max(2048),
        latest: z
          .object({
            passed: z.boolean(),
            meets_policy: z.boolean(),
            reasons: z.array(z.string().max(256)).max(64),
            trials: z.number().int().nonnegative(),
            wins: z.number().int().nonnegative(),
            losses: z.number().int().nonnegative(),
            ties: z.number().int().nonnegative(),
            p_value: z.number().min(0).max(1).nullable(),
            cost_ratio: z.number().nonnegative().nullable(),
            digest: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict()
          .nullable(),
      })
      .strict(),
  })
  .strict();
export type SkillProposalView = z.infer<typeof SkillProposalViewSchema>;
export const SkillProposalListSchema = z
  .array(SkillProposalViewSchema)
  .max(10_000);
export const SkillReviewUndoResultSchema = z
  .object({ undone: z.number().int().nonnegative() })
  .strict();

export const TaskListSchema = z.array(TaskSchema).max(10_000);
export const EventBatchSchema = z.array(EventEnvelopeSchema).max(10_000);

export function makeContext(scope: Scope, requestId: string): RequestContext {
  return { schema_version: SCHEMA_VERSION, scope, request_id: requestId };
}

export function sameScope(a: Scope, b: Scope): boolean {
  return (
    a.owner_id === b.owner_id &&
    a.project_id === b.project_id &&
    a.workspace_id === b.workspace_id
  );
}
