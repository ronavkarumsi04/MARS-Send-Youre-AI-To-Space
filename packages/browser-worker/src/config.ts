import { z } from "zod";

const host = z.string().min(1).max(253);

export const BrowserWorkerConfigSchema = z
  .object({
    /** Allows real DNS resolution and network egress; off for tests. */
    live: z.boolean().default(false),
    allow_hosts: z.array(host).max(256).optional(),
    deny_hosts: z.array(host).max(256).default([]),
    private_needles: z.array(z.string().min(1)).max(256).default([]),
    deadline_margin_ms: z.number().int().nonnegative().default(2_000),
    max_model_output_tokens: z
      .number()
      .int()
      .positive()
      .max(8_192)
      .default(400),
    max_page_chars: z.number().int().positive().max(50_000).default(6_000),
    max_elements: z.number().int().positive().max(500).default(60),
    max_extract_chars: z.number().int().positive().max(16_384).default(8_000),
    max_response_bytes: z
      .number()
      .int()
      .positive()
      .default(5 * 1024 * 1024),
    request_timeout_ms: z.number().int().positive().default(15_000),
    action_timeout_ms: z.number().int().positive().default(5_000),
    user_agent: z.string().min(1).max(256).default("MARS-BrowserWorker/0.1"),
  })
  .strict();

export type BrowserWorkerConfigInput = z.input<
  typeof BrowserWorkerConfigSchema
>;
export type BrowserWorkerConfig = z.output<typeof BrowserWorkerConfigSchema>;

export function parseBrowserWorkerConfig(
  input: BrowserWorkerConfigInput = {},
): BrowserWorkerConfig {
  return BrowserWorkerConfigSchema.parse(input);
}
