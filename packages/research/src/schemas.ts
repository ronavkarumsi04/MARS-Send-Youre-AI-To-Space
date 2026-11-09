import {
  ArtifactRefSchema,
  BudgetSchema,
  type ResearchFinding,
  type ResearchRequest,
} from "@mars/contracts";
import { type AppendEventInput, RequestContextSchema } from "@mars/tasks";
import { z } from "zod";
import type { ResearchWorkerVersion } from "./events";
import type { ResearchUsage } from "./service";

const nonempty = z.string().min(1);
const timestamp = z.string().datetime({ offset: true });
const safeInteger = z.number().int().safe();
export const ResearchTimestampSchema = timestamp;

export const ResearchRequestSchema = z
  .object({
    question: z
      .string()
      .min(1)
      .max(8192)
      .refine((value) => value.trim().length > 0),
    task_id: nonempty.max(256),
    task_revision: z.number().int().nonnegative(),
    known_context: z.array(ArtifactRefSchema).max(64),
    source_requirements: z.array(z.string().min(1).max(1024)).max(32),
    deadline: timestamp,
    budget: BudgetSchema,
  })
  .strict()
  .superRefine((request, context) => {
    const artifactIds = new Set<string>();
    for (const ref of request.known_context) {
      if (artifactIds.has(ref.artifact_id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["known_context"],
          message: "Duplicate artifact",
        });
        return;
      }
      artifactIds.add(ref.artifact_id);
    }
  });

export const FindingSourceSchema = z
  .object({
    url: z.string(),
    retrieved_at: timestamp,
    evidence: ArtifactRefSchema,
  })
  .strict();

export const FindingProposalSchema = z
  .object({
    finding_key: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    claim: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => value.trim().length > 0),
    recommendation: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => value.trim().length > 0),
    confidence: z.enum(["low", "medium", "high"]),
    remaining_uncertainty: z.array(z.string().min(1).max(1024)).max(32),
    sources: z.array(FindingSourceSchema).min(1).max(32),
  })
  .strict();

export const ResearchFindingSchema = z
  .object({
    finding_id: nonempty,
    request_id: nonempty,
    task_revision: z.number().int().nonnegative(),
    claim: nonempty,
    sources: z.array(
      z
        .object({
          url: nonempty,
          retrieved_at: timestamp,
          evidence: ArtifactRefSchema,
        })
        .strict(),
    ),
    recommendation: nonempty,
    confidence: z.enum(["low", "medium", "high"]),
    remaining_uncertainty: z.array(nonempty),
    status: z.enum(["proposed", "used", "stale"]),
  })
  .strict() satisfies z.ZodType<ResearchFinding>;
export const ResearchWorkerVersionSchema = z.object({
  id: nonempty,
  version: nonempty,
}) satisfies z.ZodType<ResearchWorkerVersion>;

export const ResearchUsageSchema = z.object({
  input_tokens: safeInteger,
  output_tokens: safeInteger,
  cost_usd: z.number().finite().nullable(),
  reported: z.boolean(),
}) satisfies z.ZodType<ResearchUsage>;

const storedEventEnvelope = {
  run_id: nonempty,
  producer: z.literal("mars-research"),
  versions: z
    .array(z.object({ component: z.string(), revision: z.string() }).strict())
    .min(1),
  source_event_ids: z.array(z.string()),
};

export const StoredResearchEventInputSchema = z.discriminatedUnion(
  "event_type",
  [
    z
      .object({
        event_type: z.literal("research.proposed"),
        ...storedEventEnvelope,
        payload: z
          .object({
            request_id: z.string(),
            finding_id: z.string(),
            task_revision: safeInteger,
            confidence: z.string(),
            source_count: safeInteger,
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        event_type: z.literal("research.stale"),
        ...storedEventEnvelope,
        payload: z
          .object({
            request_id: z.string(),
            task_revision: safeInteger,
            stale_finding_ids: z.array(z.string()),
          })
          .strict(),
      })
      .strict(),
  ],
) satisfies z.ZodType<AppendEventInput>;

export { RequestContextSchema };
export type ParsedResearchRequest = ResearchRequest;
