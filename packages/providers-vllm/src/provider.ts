import type { ModelConfig, ProviderConfig } from "@mars/contracts";
import type { ModelProviderRegistry } from "@mars/providers";
import { VLLM_PIN } from "./pin";
import type { VllmServingProfile } from "./profile";

export const VLLM_PROVIDER_ID = "vllm";
export const VLLM_DEFAULT_URL = "http://127.0.0.1:8000";
/** Optional `--api-key` of the operator's vLLM server, read by name only. */
export const VLLM_API_KEY_ENV = "MARS_VLLM_API_KEY";
export const VLLM_ROUTE = "vllm";
/** Adapter names on the server are the adapter bundle's sha256. */
export const ADAPTER_NAME_PATTERN = /^[a-f0-9]{64}$/;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

export interface VllmUrlOptions {
  /** A non-loopback server is refused unless this is set explicitly. */
  allowRemote?: boolean;
}

/** Normalizes a vLLM origin (optionally ending in `/v1`) to its origin. */
export function vllmOrigin(
  url: string = VLLM_DEFAULT_URL,
  options: VllmUrlOptions = {},
): string {
  const parsed = new URL(url);
  if (parsed.search || parsed.hash || parsed.username || parsed.password)
    throw new Error("vLLM URL must be a bare origin or /v1 base URL.");
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new Error("vLLM URL must use http (loopback only) or https.");
  const loopback = LOOPBACK_HOSTS.has(parsed.hostname);
  if (!loopback && options.allowRemote !== true)
    throw new Error(
      "vLLM URL is not loopback; attaching to a remote server needs the explicit allow-remote flag.",
    );
  if (!loopback && parsed.protocol === "http:")
    throw new Error(
      "Plain http is allowed only for a loopback vLLM; use https for a remote server.",
    );
  const path = parsed.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  if (path !== "")
    throw new Error("vLLM URL must not carry a path other than /v1.");
  return parsed.origin;
}

export interface VllmProviderOptions extends VllmUrlOptions {
  url?: string;
  apiKeyEnv?: string;
}

export function vllmProvider(
  options: VllmProviderOptions = {},
): ProviderConfig {
  return {
    id: VLLM_PROVIDER_ID,
    kind: "openai-compatible",
    baseUrl: `${vllmOrigin(options.url, options)}/v1`,
    ...(options.apiKeyEnv ? { apiKeyEnv: options.apiKeyEnv } : {}),
    docsUrl: "https://docs.vllm.ai/en/v0.32.0/features/lora/",
    freeTier: `Operator-started vLLM ${VLLM_PIN.release} (self-hosted, no per-token charge); MARS attaches and never starts it.`,
  };
}

export function vllmModelId(servedName: string): string {
  return `${VLLM_PROVIDER_ID}/${servedName}`;
}

/** The served base plus each attested adapter (by bundle sha256). */
export function vllmModels(
  profile: VllmServingProfile,
  listing: { context_window: number; adapter_sha256s: readonly string[] },
): ModelConfig[] {
  const capabilities = {
    tools: profile.capabilities.tools,
    vision: profile.capabilities.vision,
    contextWindow: listing.context_window,
    ...(profile.capabilities.reasoning !== undefined
      ? { reasoning: profile.capabilities.reasoning }
      : {}),
  };
  const model = (served: string, tags: string[]): ModelConfig => ({
    id: vllmModelId(served),
    providerId: VLLM_PROVIDER_ID,
    model: served,
    capabilities,
    pricing: { free: true },
    tags: ["vllm", "self-hosted", ...tags],
  });
  return [
    model(profile.served_model_name, ["vllm:base"]),
    ...listing.adapter_sha256s
      .filter((sha) => ADAPTER_NAME_PATTERN.test(sha))
      .map((sha) => model(sha, ["vllm:adapter", "peft-lora"])),
  ];
}

export interface VllmRegistryOptions extends VllmProviderOptions {
  models: ModelConfig[];
  env?: Record<string, string | undefined>;
}

/**
 * Adds the vLLM provider target and a `vllm` route over a loaded registry.
 * The default route and `policy.allowPaid` are untouched: free-first and
 * paid consent stay owned by `@mars/providers` and the specialist router.
 */
export function extendRegistryWithVllm(
  registry: ModelProviderRegistry,
  options: VllmRegistryOptions,
): ModelProviderRegistry {
  const provider = vllmProvider(options);
  return registry.extend({
    providers: [provider],
    models: options.models,
    routes: { [VLLM_ROUTE]: options.models.map(({ id }) => id) },
    ...(options.env ? { env: options.env } : {}),
    notice: `vLLM target attached at ${provider.baseUrl}: ${options.models.length} served models (base + attested adapters), pinned ${VLLM_PIN.release}.`,
  });
}
