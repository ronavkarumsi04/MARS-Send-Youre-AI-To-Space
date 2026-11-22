import { z } from "zod";

const sessionId = z.string().uuid();
const turn = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(32_000),
});

export const AssistantSessionsSchema = z
  .array(
    z.object({
      id: sessionId,
      title: z.string().max(80),
      messages: z.array(turn).max(100),
    }),
  )
  .max(50);

export const AssistantRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("assistantLoad") }).strict(),
  z.object({ type: z.literal("assistantSetKey") }).strict(),
  z.object({ type: z.literal("assistantRemoveKey") }).strict(),
  z
    .object({
      type: z.literal("assistantSend"),
      id: sessionId,
      text: z.string().trim().min(1).max(8000),
      consent: z.literal(true),
    })
    .strict(),
]);

export const WorkspaceActionSchema = z
  .object({
    type: z.enum([
      "importConnection",
      "openSettings",
      "openSkills",
      "openKeyPage",
    ]),
  })
  .strict();

export type AssistantRequest = z.infer<typeof AssistantRequestSchema>;
export type WorkspaceAction = z.infer<typeof WorkspaceActionSchema>;
export type AssistantSession = z.infer<typeof AssistantSessionsSchema>[number];
export type AssistantTurn = z.infer<typeof turn>;
export type AssistantUpdate = {
  type: "assistantState";
  configured: boolean;
  sessions?: AssistantSession[];
  completesSend?: boolean;
  error?: string;
};
