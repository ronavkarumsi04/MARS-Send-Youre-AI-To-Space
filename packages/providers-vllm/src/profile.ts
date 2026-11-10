import { readFile } from "node:fs/promises";
import { type VersionRef, VersionRefSchema } from "@mars/contracts";
import { z } from "zod";

/**
 * What the operator pinned about the vLLM server MARS attaches to. vLLM
 * v0.32.0 `/v1/models` reports served names, model paths and LoRA parents
 * but no base revision, tokenizer revision or chat template, so those come
 * from this profile and are trusted as operator statements; the live server
 * must still agree on the served base name and (when set) its model path.
 */
export const VllmServingProfileSchema = z
  .object({
    schema_version: z.literal(1),
    /** `--served-model-name` (or the model path when none is given). */
    served_model_name: z.string().min(1).max(200),
    /** Expected `root` of the base card (`--model`); unchecked when absent. */
    model_path: z.string().min(1).max(4096).optional(),
    base_model: VersionRefSchema,
    tokenizer: VersionRefSchema,
    chat_template_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    capabilities: z
      .object({
        tools: z.boolean(),
        vision: z.boolean(),
        reasoning: z.boolean().optional(),
      })
      .strict(),
    /** `--max-lora-rank`; informational until adapter ranks are recorded. */
    max_lora_rank: z.number().int().positive().optional(),
  })
  .strict();
export type VllmServingProfile = z.infer<typeof VllmServingProfileSchema>;

export async function loadVllmServingProfile(
  path: string,
): Promise<VllmServingProfile> {
  return VllmServingProfileSchema.parse(
    JSON.parse(await readFile(path, "utf8")),
  );
}

export function sameVersionRef(a: VersionRef, b: VersionRef): boolean {
  return a.component === b.component && a.revision === b.revision;
}
