import { z } from "zod";

export const ASSISTANT_CHANNEL = "mars-shell:assistant";
export const AssistantMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string().max(32_000),
  })
  .strict();
export const AssistantSessionSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().max(100),
    messages: z.array(AssistantMessageSchema).max(100),
  })
  .strict();
export type AssistantSession = z.infer<typeof AssistantSessionSchema>;
export const AssistantRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("load") }).strict(),
  z.object({ action: z.literal("settings") }).strict(),
  z
    .object({
      action: z.literal("send"),
      id: z.string().uuid(),
      text: z.string().trim().min(1).max(8000),
      consent: z.literal(true),
    })
    .strict(),
]);
export type AssistantRequest = z.infer<typeof AssistantRequestSchema>;
export type AssistantResult =
  | {
      ok: true;
      sessions: AssistantSession[];
      configured: boolean;
      canConfigure: boolean;
    }
  | { ok: false; error: string };
export type AssistantApi = {
  request(payload: AssistantRequest): Promise<AssistantResult>;
};
