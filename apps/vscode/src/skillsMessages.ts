import { z } from "zod";
import type { SkillProposalView, SkillView } from "./protocol";

const shortId = z.string().min(1).max(256);
/** Messages the Skills webview may send. Anything else is dropped. */
export const SkillsMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }).strict(),
  z.object({ type: z.literal("refresh") }).strict(),
  z.object({ type: z.literal("accept"), proposalId: shortId }).strict(),
  z.object({ type: z.literal("reject"), proposalId: shortId }).strict(),
  z.object({ type: z.literal("undo"), reviewId: shortId }).strict(),
]);
export type SkillsMessage = z.infer<typeof SkillsMessageSchema>;

export interface SkillsState {
  connected: boolean;
  skills: SkillView[];
  proposals: SkillProposalView[];
  busy: string | null;
  notice: { kind: "info" | "error"; text: string } | null;
}
