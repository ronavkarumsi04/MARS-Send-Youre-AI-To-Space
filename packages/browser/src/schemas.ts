import { ArtifactRefSchema, BudgetSchema } from "@mars/contracts";
import { z } from "zod";

const timestamp = z.string().datetime({ offset: true });
const safeInteger = z.number().int().safe().nonnegative();
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0);

/** Element references come from the worker's own page snapshot, never from page content. */
export const ElementRefSchema = z.string().regex(/^e[0-9]{1,5}$/);

export const BROWSER_KEYS = [
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "Space",
] as const;

export const BrowserUrlSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "https:" || url.protocol === "http:") &&
        url.username === "" &&
        url.password === ""
      );
    } catch {
      return false;
    }
  }, "Only http(s) URLs without credentials");

export const BrowserActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), url: BrowserUrlSchema }).strict(),
  z.object({ type: z.literal("click"), ref: ElementRefSchema }).strict(),
  z
    .object({
      type: z.literal("type"),
      ref: ElementRefSchema,
      text: z.string().max(2000),
    })
    .strict(),
  z.object({ type: z.literal("press"), key: z.enum(BROWSER_KEYS) }).strict(),
  z
    .object({ type: z.literal("scroll"), direction: z.enum(["up", "down"]) })
    .strict(),
  z.object({ type: z.literal("back") }).strict(),
  z.object({ type: z.literal("screenshot") }).strict(),
  z.object({ type: z.literal("extract") }).strict(),
  z
    .object({
      type: z.literal("done"),
      success: z.boolean(),
      result: text(4096),
    })
    .strict(),
]);
export type BrowserAction = z.infer<typeof BrowserActionSchema>;
export type BrowserActionType = BrowserAction["type"];

/** Actions a request may allow; `done` is the worker's own stop signal and always allowed. */
export const BROWSER_ACTION_TYPES = [
  "navigate",
  "click",
  "type",
  "press",
  "scroll",
  "back",
  "screenshot",
  "extract",
] as const;
export type BrowserPolicyAction = (typeof BROWSER_ACTION_TYPES)[number];
export const BrowserPolicyActionSchema = z.enum(BROWSER_ACTION_TYPES);

/** Read-only browsing: no typing, no key presses that could submit a form. */
export const DEFAULT_ALLOWED_ACTIONS: readonly BrowserPolicyAction[] = [
  "navigate",
  "click",
  "scroll",
  "back",
  "screenshot",
  "extract",
];

export const BrowserRequestSchema = z
  .object({
    goal: text(4096),
    task_id: z.string().min(1).max(256),
    task_revision: safeInteger,
    start_url: BrowserUrlSchema,
    /** Explicit steps run in order without a model; omit to let the worker plan. */
    actions: z
      .array(BrowserActionSchema)
      .max(32)
      .refine((actions) => actions.every((action) => action.type !== "done"))
      .optional(),
    allowed_actions: z.array(BrowserPolicyActionSchema).min(1).max(8),
    /** Reuse cookies/storage of an earlier job of the same task with this key. */
    session_key: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,64}$/)
      .optional(),
    max_steps: z.number().int().min(1).max(50),
    deadline: timestamp,
    budget: BudgetSchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (new Set(request.allowed_actions).size !== request.allowed_actions.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowed_actions"],
        message: "Duplicate action",
      });
    for (const action of request.actions ?? []) {
      if (!request.allowed_actions.includes(action.type as BrowserPolicyAction))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["actions"],
          message: "Action is not allowed by the request policy",
        });
    }
    if ((request.actions?.length ?? 0) > request.max_steps)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["actions"],
        message: "More actions than max_steps",
      });
  });
export type BrowserRequest = z.infer<typeof BrowserRequestSchema>;

export const BrowserStepSchema = z
  .object({
    index: z.number().int().min(0).max(1000),
    action: BrowserActionSchema,
    outcome: z.enum(["ok", "blocked", "failed"]),
    detail: z.string().max(1024),
    url: z.string().max(2048),
    title: z.string().max(512),
    artifacts: z.array(ArtifactRefSchema).max(4),
  })
  .strict();
export type BrowserStep = z.infer<typeof BrowserStepSchema>;

export const BrowserResultSchema = z
  .object({
    success: z.boolean(),
    summary: text(4096),
    extracted: z.string().max(16_384).optional(),
    final_url: z.string().max(2048),
    artifacts: z.array(ArtifactRefSchema).max(32),
  })
  .strict();
export type BrowserResult = z.infer<typeof BrowserResultSchema>;

export const BrowserUsageSchema = z
  .object({
    input_tokens: safeInteger,
    output_tokens: safeInteger,
    cost_usd: z.number().finite().nonnegative().nullable(),
    reported: z.boolean(),
  })
  .strict();
export type BrowserUsage = z.infer<typeof BrowserUsageSchema>;

export const BrowserWorkerVersionSchema = z
  .object({ id: z.string().min(1), version: z.string().min(1) })
  .strict();
