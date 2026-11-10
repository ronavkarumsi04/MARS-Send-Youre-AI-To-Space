import { z } from "zod";
import { VLLM_PIN, versionMatchesPin } from "./pin";
import { type VllmUrlOptions, vllmOrigin } from "./provider";

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export type VllmErrorCode =
  | "unreachable"
  | "malformed"
  | "unauthorized"
  | "http_error"
  | "version_mismatch"
  | "runtime_lora_unavailable";

/** Messages carry status codes and fixed text only, never keys or bodies. */
export class VllmError extends Error {
  constructor(
    readonly code: VllmErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "VllmError";
  }
}

/** `ModelCard` at the pin (`vllm/entrypoints/serve/engine/protocol.py`). */
const ModelCardSchema = z
  .object({
    id: z.string().min(1),
    object: z.literal("model"),
    root: z.string().nullable().optional(),
    parent: z.string().nullable().optional(),
    max_model_len: z.number().int().positive().nullable().optional(),
  })
  .passthrough();
const ModelListSchema = z
  .object({ object: z.literal("list"), data: z.array(ModelCardSchema) })
  .passthrough();
const VersionSchema = z.object({ version: z.string().min(1) }).passthrough();

export interface VllmModelCard {
  id: string;
  root: string | null;
  parent: string | null;
  max_model_len: number | null;
}

export interface VllmClientOptions extends VllmUrlOptions {
  url?: string;
  apiKeyEnv?: string;
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
  timeoutMs?: number;
}

/**
 * Talks to an operator-started vLLM server: `GET /version`, `GET /v1/models`
 * and, only when the server runs with `VLLM_ALLOW_RUNTIME_LORA_UPDATING`,
 * `POST /v1/{load,unload}_lora_adapter`. Never a completion request.
 */
export class VllmClient {
  readonly origin: string;
  private readonly fetcher: FetchLike;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;

  constructor(options: VllmClientOptions = {}) {
    this.origin = vllmOrigin(options.url, options);
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    const env = options.env ?? process.env;
    this.apiKey = options.apiKeyEnv ? env[options.apiKeyEnv] : undefined;
    this.timeoutMs = options.timeoutMs ?? 2_000;
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const headers = new Headers({ Accept: "application/json" });
    if (this.apiKey) headers.set("Authorization", `Bearer ${this.apiKey}`);
    if (body !== undefined) headers.set("Content-Type", "application/json");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetcher(`${this.origin}${path}`, {
        method,
        headers,
        signal: controller.signal,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new VllmError("unreachable", `vLLM did not answer ${path}.`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async json(path: string): Promise<unknown> {
    const response = await this.request("GET", path);
    if (response.status === 401 || response.status === 403)
      throw new VllmError(
        "unauthorized",
        `vLLM refused ${path} (HTTP ${response.status}).`,
        response.status,
      );
    if (!response.ok)
      throw new VllmError(
        "http_error",
        `vLLM answered ${path} with HTTP ${response.status}.`,
        response.status,
      );
    try {
      return await response.json();
    } catch {
      throw new VllmError("malformed", `vLLM ${path} is not JSON.`);
    }
  }

  async version(): Promise<string> {
    const parsed = VersionSchema.safeParse(await this.json("/version"));
    if (!parsed.success)
      throw new VllmError("malformed", "vLLM /version has no version string.");
    return parsed.data.version;
  }

  /** Throws `version_mismatch` unless the server is the pinned release. */
  async assertPinnedVersion(): Promise<string> {
    const version = await this.version();
    if (!versionMatchesPin(version))
      throw new VllmError(
        "version_mismatch",
        `vLLM reports ${JSON.stringify(version.slice(0, 64))}; MARS is pinned to ${VLLM_PIN.version}.`,
      );
    return version;
  }

  async models(): Promise<VllmModelCard[]> {
    const parsed = ModelListSchema.safeParse(await this.json("/v1/models"));
    if (!parsed.success)
      throw new VllmError("malformed", "vLLM /v1/models is not a model list.");
    const ids = new Set<string>();
    return parsed.data.data.map((card) => {
      if (ids.has(card.id))
        throw new VllmError("malformed", "vLLM /v1/models repeats an id.");
      ids.add(card.id);
      return {
        id: card.id,
        root: card.root ?? null,
        parent: card.parent ?? null,
        max_model_len: card.max_model_len ?? null,
      };
    });
  }

  private async lora(
    path: "/v1/load_lora_adapter" | "/v1/unload_lora_adapter",
    body: Record<string, string>,
  ): Promise<void> {
    const response = await this.request("POST", path, body);
    await response.body?.cancel().catch(() => undefined);
    if (response.ok) return;
    // The routes are not mounted unless VLLM_ALLOW_RUNTIME_LORA_UPDATING is set.
    if (response.status === 404 && path === "/v1/load_lora_adapter")
      throw new VllmError(
        "runtime_lora_unavailable",
        "vLLM does not expose runtime LoRA loading (VLLM_ALLOW_RUNTIME_LORA_UPDATING is off on the server).",
        404,
      );
    if (response.status === 401 || response.status === 403)
      throw new VllmError(
        "unauthorized",
        `vLLM refused ${path} (HTTP ${response.status}).`,
        response.status,
      );
    throw new VllmError(
      "http_error",
      `vLLM answered ${path} with HTTP ${response.status}.`,
      response.status,
    );
  }

  loadAdapter(name: string, path: string): Promise<void> {
    return this.lora("/v1/load_lora_adapter", {
      lora_name: name,
      lora_path: path,
    });
  }

  unloadAdapter(name: string): Promise<void> {
    return this.lora("/v1/unload_lora_adapter", { lora_name: name });
  }
}
