import {
  IntegrityError,
  LimitExceededError,
  SandboxUnavailableError,
  WorkspacePolicyError,
} from "@mars/workspaces";
import { z } from "zod";

/**
 * The OpenHands Agent Server revision this client speaks. Every route, field
 * and status code below was read from this exact source; see
 * documentation/REMOTE_WORKSPACES.md for the per-file list.
 */
export const PINNED_AGENT_SERVER = {
  repository: "https://github.com/OpenHands/software-agent-sdk",
  revision: "c048a1eb82353b0586f3ce600708394a68ebb246",
  title: "OpenHands Agent Server",
  versions: ["1.59.0"] as readonly string[],
} as const;

export const SESSION_KEY_HEADER = "X-Session-API-Key";

const ServerInfoSchema = z
  .object({
    title: z.string(),
    version: z.string(),
    sdk_version: z.string().optional(),
    workspace_version: z.string().optional(),
    build_git_sha: z.string().optional(),
    conversation_runtime: z.enum(["local", "docker"]).optional(),
    capabilities: z.array(z.string()).optional(),
  })
  .passthrough();
export type AgentServerInfo = z.infer<typeof ServerInfoSchema>;

const BashCommandSchema = z
  .object({ id: z.string().uuid(), command: z.string() })
  .passthrough();

const BashOutputSchema = z
  .object({
    kind: z.literal("BashOutput"),
    id: z.string(),
    command_id: z.string(),
    order: z.number().int().nonnegative(),
    exit_code: z.number().int().nullable().optional(),
    stdout: z.string().nullable().optional(),
    stderr: z.string().nullable().optional(),
  })
  .passthrough();
export type BashOutputEvent = z.infer<typeof BashOutputSchema>;

const BashEventPageSchema = z
  .object({
    items: z.array(z.unknown()),
    next_page_id: z.string().nullable().optional(),
  })
  .passthrough();

const UploadResultSchema = z
  .object({ success: z.boolean(), file_size: z.number().int().nonnegative() })
  .passthrough();

export interface AgentServerClientOptions {
  /** Base URL, e.g. https://agent.example:8000. */
  url: string;
  /** Value of X-Session-API-Key; never logged, never echoed in errors. */
  apiKey?: string;
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** Per-request timeout for every call except command polling waits. */
  requestTimeoutMs?: number;
  /** Extra attempts for idempotent calls only (GET, stop, byte-exact upload). */
  retries?: number;
  retryDelayMs?: number;
  /** Plain http to a non-loopback host would send the key in clear text. */
  allowInsecureHttp?: boolean;
  /** Bound on any JSON response body. */
  maxResponseBytes?: number;
  supportedVersions?: readonly string[];
}

export type TransportSecurity = "https" | "http-loopback" | "http-insecure";

export interface AgentServerClient {
  readonly url: string;
  readonly transport: TransportSecurity;
  readonly authenticated: boolean;
  /** Identity + version gate; fails closed on anything not pinned. */
  verify(): Promise<AgentServerInfo>;
  startCommand(
    command: string,
    cwd: string,
    timeoutSeconds: number,
  ): Promise<string>;
  searchOutput(
    commandId: string,
    afterOrder: number,
    pageId?: string,
  ): Promise<{ items: BashOutputEvent[]; next_page_id: string | null }>;
  stopCommand(commandId: string): Promise<void>;
  upload(path: string, data: Uint8Array): Promise<void>;
  download(path: string, maxBytes: number): Promise<Uint8Array>;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function transportSecurity(url: URL): TransportSecurity {
  if (url.protocol === "https:") return "https";
  return LOOPBACK.has(url.hostname) ? "http-loopback" : "http-insecure";
}

/** Absolute POSIX path without `.`/`..`/empty segments or control bytes. */
export function assertRemotePath(path: string): string {
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.length > 4096 ||
    path
      .slice(1)
      .split("/")
      .some((part) => part === "" || part === "." || part === "..") ||
    [...path].some((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    })
  )
    throw new WorkspacePolicyError("Invalid remote workspace path");
  return path;
}

class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`Agent Server answered HTTP ${status}`);
  }
}

export function createAgentServerClient(
  options: AgentServerClientOptions,
): AgentServerClient {
  let base: URL;
  try {
    base = new URL(options.url);
  } catch {
    throw new WorkspacePolicyError("Agent Server URL is not a valid URL");
  }
  if (base.protocol !== "https:" && base.protocol !== "http:")
    throw new WorkspacePolicyError("Agent Server URL must be http(s)");
  if (base.username || base.password || base.search || base.hash)
    throw new WorkspacePolicyError(
      "Agent Server URL must not carry credentials, a query or a fragment",
    );
  const transport = transportSecurity(base);
  if (transport === "http-insecure" && !options.allowInsecureHttp)
    throw new WorkspacePolicyError(
      "Agent Server URL must be https unless it is a loopback address",
    );
  const root = base.toString().replace(/\/+$/, "");
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const retries = Math.max(0, Math.min(options.retries ?? 2, 5));
  const retryDelayMs = options.retryDelayMs ?? 200;
  const maxResponseBytes = options.maxResponseBytes ?? 4 * 1024 * 1024;
  const supported = options.supportedVersions ?? PINNED_AGENT_SERVER.versions;
  const apiKey = options.apiKey;
  const headers = (): Record<string, string> =>
    apiKey ? { [SESSION_KEY_HEADER]: apiKey } : {};

  const unavailable = (what: string, cause?: unknown): Error =>
    new SandboxUnavailableError(
      `Agent Server ${what} failed`,
      cause === undefined ? undefined : { cause: scrubCause(cause) },
    );
  const scrubCause = (cause: unknown): Error => {
    const message =
      cause instanceof Error ? cause.message : String(cause ?? "error");
    return new Error(
      apiKey ? message.split(apiKey).join("[redacted]") : message,
    );
  };

  async function readBounded(
    response: Response,
    limit: number,
  ): Promise<Uint8Array> {
    const declared = Number(response.headers.get("content-length") ?? "NaN");
    if (Number.isFinite(declared) && declared > limit) {
      await response.body?.cancel().catch(() => undefined);
      throw new LimitExceededError("Agent Server response exceeds its bound");
    }
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new LimitExceededError("Agent Server response exceeds its bound");
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  /**
   * One HTTP exchange with a hard timeout. `idempotent` requests are retried
   * on transport errors and 5xx/429; anything else is attempted exactly once,
   * because a lost response may still have taken effect on the server.
   */
  async function request(
    what: string,
    path: string,
    init: { method: string; body?: BodyInit; idempotent: boolean },
    accept: (response: Response) => Promise<Uint8Array | null>,
  ): Promise<Uint8Array | null> {
    const attempts = init.idempotent ? retries + 1 : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0)
        await new Promise((resolve) =>
          setTimeout(resolve, retryDelayMs * 2 ** (attempt - 1)),
        );
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error("timeout")),
        requestTimeoutMs,
      );
      try {
        const response = await doFetch(`${root}${path}`, {
          method: init.method,
          headers: headers(),
          ...(init.body !== undefined ? { body: init.body } : {}),
          signal: controller.signal,
          redirect: "error",
        });
        if (response.status >= 500 || response.status === 429) {
          await response.body?.cancel().catch(() => undefined);
          lastError = new HttpStatusError(response.status);
          continue;
        }
        return await accept(response);
      } catch (error) {
        if (
          error instanceof HttpStatusError ||
          error instanceof LimitExceededError ||
          error instanceof IntegrityError ||
          error instanceof WorkspacePolicyError ||
          error instanceof SandboxUnavailableError
        )
          throw error;
        lastError = error;
      } finally {
        clearTimeout(timer);
      }
    }
    throw unavailable(what, lastError);
  }

  async function json(
    what: string,
    path: string,
    init: { method: string; body?: BodyInit; idempotent: boolean },
    okStatuses: readonly number[] = [200],
  ): Promise<{ status: number; body: unknown }> {
    let status = 0;
    const bytes = await request(what, path, init, async (response) => {
      status = response.status;
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => undefined);
        throw new SandboxUnavailableError(
          `Agent Server ${what} was refused: authentication failed`,
        );
      }
      if (!okStatuses.includes(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        throw new HttpStatusError(response.status);
      }
      return readBounded(response, maxResponseBytes);
    });
    if (status === 204 || !bytes || bytes.byteLength === 0)
      return { status, body: null };
    try {
      return {
        status,
        body: JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        ),
      };
    } catch (error) {
      throw new IntegrityError(`Agent Server ${what} returned invalid JSON`, {
        cause: scrubCause(error),
      });
    }
  }

  const parse = <T>(what: string, schema: z.ZodType<T>, value: unknown): T => {
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw new IntegrityError(
        `Agent Server ${what} response does not match the pinned protocol`,
      );
    return parsed.data;
  };

  const mapStatus = (what: string, error: unknown): never => {
    if (error instanceof HttpStatusError) {
      if (error.status === 404)
        throw new SandboxUnavailableError(`Agent Server ${what}: not found`);
      if (error.status === 400 || error.status === 422)
        throw new WorkspacePolicyError(
          `Agent Server rejected ${what} (HTTP ${error.status})`,
        );
      throw unavailable(what, error);
    }
    throw error;
  };

  return {
    url: root,
    transport,
    authenticated: Boolean(apiKey),
    async verify() {
      const { body } = await json("server_info", "/server_info", {
        method: "GET",
        idempotent: true,
      }).catch((error) => mapStatus("server_info", error));
      const info = parse("server_info", ServerInfoSchema, body);
      if (info.title !== PINNED_AGENT_SERVER.title)
        throw new SandboxUnavailableError(
          "Remote server does not identify as the OpenHands Agent Server",
        );
      if (!supported.includes(info.version))
        throw new SandboxUnavailableError(
          `Unsupported Agent Server version ${JSON.stringify(info.version.slice(0, 40))}; this client speaks ${supported.join(", ")}`,
        );
      return info;
    },
    async startCommand(command, cwd, timeoutSeconds) {
      assertRemotePath(cwd);
      const { body } = await json(
        "start_bash_command",
        "/api/bash/start_bash_command",
        {
          method: "POST",
          body: JSON.stringify({
            command,
            cwd,
            timeout: Math.max(1, Math.ceil(timeoutSeconds)),
          }),
          idempotent: false,
        },
      ).catch((error) => mapStatus("start_bash_command", error));
      return parse("start_bash_command", BashCommandSchema, body).id;
    },
    async searchOutput(commandId, afterOrder, pageId) {
      const params = new URLSearchParams({
        kind__eq: "BashOutput",
        command_id__eq: commandId,
        sort_order: "TIMESTAMP",
        limit: "100",
      });
      if (afterOrder >= 0) params.set("order__gt", String(afterOrder));
      if (pageId) params.set("page_id", pageId);
      const { body } = await json(
        "bash_events/search",
        `/api/bash/bash_events/search?${params}`,
        { method: "GET", idempotent: true },
      ).catch((error) => mapStatus("bash_events/search", error));
      const page = parse("bash_events/search", BashEventPageSchema, body);
      const items = page.items.map((item) =>
        parse("bash_events/search", BashOutputSchema, item),
      );
      for (const item of items)
        if (
          item.command_id.replaceAll("-", "") !== commandId.replaceAll("-", "")
        )
          throw new IntegrityError(
            "Agent Server returned output of another command",
          );
      return { items, next_page_id: page.next_page_id ?? null };
    },
    async stopCommand(commandId) {
      await json(
        "stop",
        `/api/bash/bash_commands/${encodeURIComponent(commandId)}/stop`,
        { method: "POST", idempotent: true },
        [200, 404],
      ).catch((error) => mapStatus("stop", error));
    },
    async upload(path, data) {
      assertRemotePath(path);
      const { body } = await json(
        "file/upload",
        `/api/file/upload?${new URLSearchParams({ path })}`,
        {
          method: "POST",
          // Re-sending the same bytes to the same path converges on the same
          // file, so an upload whose response was lost may be retried.
          idempotent: true,
          get body() {
            const form = new FormData();
            form.set("file", new Blob([new Uint8Array(data)]), "upload");
            return form;
          },
        },
      ).catch((error) => mapStatus("file/upload", error));
      const result = parse("file/upload", UploadResultSchema, body);
      if (!result.success || result.file_size !== data.byteLength)
        throw new IntegrityError("Agent Server upload size does not match");
    },
    async download(path, maxBytes) {
      assertRemotePath(path);
      const bytes = await request(
        "file/download",
        `/api/file/download?${new URLSearchParams({ path })}`,
        { method: "GET", idempotent: true },
        async (response) => {
          if (response.status === 401 || response.status === 403) {
            await response.body?.cancel().catch(() => undefined);
            throw new SandboxUnavailableError(
              "Agent Server file/download was refused: authentication failed",
            );
          }
          if (response.status !== 200) {
            await response.body?.cancel().catch(() => undefined);
            throw new HttpStatusError(response.status);
          }
          return readBounded(response, maxBytes);
        },
      ).catch((error) => mapStatus("file/download", error));
      return bytes ?? new Uint8Array();
    },
  };
}
