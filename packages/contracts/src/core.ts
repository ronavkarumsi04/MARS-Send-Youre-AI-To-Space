import { z } from "zod";

/**
 * Leaf primitives shared by `index.ts` and sibling contract modules such as
 * `team.ts`. Keep this module free of imports from `./index` so it can be
 * imported eagerly without a module cycle.
 */
export const SCHEMA_VERSION = 1;
const id = z.string().min(1);

export const ScopeSchema = z
  .object({
    owner_id: id,
    project_id: id,
    workspace_id: id.optional(),
  })
  .strict();
export type Scope = z.infer<typeof ScopeSchema>;

export const ArtifactRefSchema = z
  .object({
    artifact_id: id,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    media_type: id,
    byte_length: z.number().int().nonnegative(),
  })
  .strict();
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const TaskStatusSchema = z.enum([
  "pending",
  "running",
  "paused",
  "completed",
  "cancelled",
  "failed",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
