import { VLLM_PIN } from "../pin";

export interface FakeVllmRequest {
  method: string;
  path: string;
  authorized: boolean;
  body: unknown;
}

export interface FakeVllmState {
  version: string;
  baseName: string;
  baseRoot: string;
  maxModelLen: number;
  /** Loaded adapters: name -> path. */
  adapters: Map<string, string>;
  /** Mirrors `VLLM_ALLOW_RUNTIME_LORA_UPDATING`: off means the routes 404. */
  runtimeLoraUpdating: boolean;
  /** Corrupts one endpoint's body to exercise malformed-response handling. */
  malformed: "version" | "models" | "not-json" | null;
  /** An unload that answers 200 but leaves the adapter listed. */
  stickyUnload: boolean;
}

export interface FakeVllm {
  url: string;
  state: FakeVllmState;
  requests: FakeVllmRequest[];
  /** Requests to anything other than /version, /v1/models and the LoRA routes. */
  modelRequests(): FakeVllmRequest[];
  stop(): Promise<void>;
}

export interface FakeVllmOptions
  extends Partial<Omit<FakeVllmState, "adapters">> {
  adapters?: Record<string, string>;
  apiKey?: string;
  completions?: (body: unknown) => string;
}

const CONTROL_PATHS = new Set([
  "/version",
  "/v1/models",
  "/v1/load_lora_adapter",
  "/v1/unload_lora_adapter",
]);

function error(status: number, message: string): Response {
  return Response.json(
    { error: { message, type: "BadRequestError", code: status } },
    { status },
  );
}

/**
 * An in-process loopback stand-in for `vllm serve` at the pin, shaped after
 * `vllm/entrypoints/{openai/models,serve/lora}/api_router.py`. Records every
 * request (no bodies of secrets: only an `authorized` flag).
 */
export function startFakeVllm(options: FakeVllmOptions = {}): FakeVllm {
  const state: FakeVllmState = {
    version: options.version ?? VLLM_PIN.version,
    baseName: options.baseName ?? "mars-base",
    baseRoot: options.baseRoot ?? "/models/mars-base",
    maxModelLen: options.maxModelLen ?? 32768,
    adapters: new Map(Object.entries(options.adapters ?? {})),
    runtimeLoraUpdating: options.runtimeLoraUpdating ?? false,
    malformed: options.malformed ?? null,
    stickyUnload: options.stickyUnload ?? false,
  };
  const requests: FakeVllmRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const authorized =
        options.apiKey === undefined ||
        request.headers.get("authorization") === `Bearer ${options.apiKey}`;
      let body: unknown = null;
      if (request.method === "POST")
        body = await request.json().catch(() => null);
      requests.push({
        method: request.method,
        path: url.pathname,
        authorized,
        body,
      });
      if (url.pathname.startsWith("/v1/") && !authorized)
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      if (request.method === "GET" && url.pathname === "/version") {
        if (state.malformed === "version") return Response.json({ v: 1 });
        return Response.json({ version: state.version });
      }
      if (request.method === "GET" && url.pathname === "/v1/models") {
        if (state.malformed === "not-json") return new Response("<html>");
        if (state.malformed === "models")
          return Response.json({ object: "list", data: [{ id: 7 }] });
        const card = (
          id: string,
          root: string,
          parent: string | null,
          maxLen: number | null,
        ) => ({
          id,
          object: "model",
          created: 0,
          owned_by: "vllm",
          root,
          parent,
          max_model_len: maxLen,
          permission: [],
        });
        return Response.json({
          object: "list",
          data: [
            card(state.baseName, state.baseRoot, null, state.maxModelLen),
            ...[...state.adapters].map(([name, path]) =>
              card(name, path, state.baseName, null),
            ),
          ],
        });
      }
      const lora =
        url.pathname === "/v1/load_lora_adapter" ||
        url.pathname === "/v1/unload_lora_adapter";
      if (
        request.method === "POST" &&
        url.pathname === "/v1/chat/completions" &&
        options.completions
      ) {
        return Response.json({
          id: "fake-completion",
          object: "chat.completion",
          created: 0,
          model: (body as { model?: string } | null)?.model ?? state.baseName,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: options.completions(body),
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      if (request.method === "POST" && lora) {
        if (!state.runtimeLoraUpdating)
          return Response.json({ detail: "Not Found" }, { status: 404 });
        const input = (body ?? {}) as Record<string, unknown>;
        const name = input.lora_name;
        if (typeof name !== "string" || name === "")
          return error(400, "lora_name is required");
        if (url.pathname === "/v1/load_lora_adapter") {
          if (typeof input.lora_path !== "string" || input.lora_path === "")
            return error(400, "lora_path is required");
          if (state.adapters.has(name))
            return error(
              400,
              `The lora adapter '${name}' has already been loaded.`,
            );
          state.adapters.set(name, input.lora_path);
          return new Response(
            `Success: LoRA adapter '${name}' added successfully.`,
          );
        }
        if (!state.adapters.has(name))
          return error(404, `The lora adapter '${name}' cannot be found.`);
        if (!state.stickyUnload) state.adapters.delete(name);
        return new Response(
          `Success: LoRA adapter '${name}' removed successfully.`,
        );
      }
      return error(500, "fake vLLM serves no completions");
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    state,
    requests,
    modelRequests: () =>
      requests.filter(({ path }) => !CONTROL_PATHS.has(path)),
    stop: async () => {
      await server.stop(true);
    },
  };
}
