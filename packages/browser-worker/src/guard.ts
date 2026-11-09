import {
  type FetchLike,
  type HostResolver,
  hostAllowed,
  hostnameBlocked,
  isPrivateAddress,
} from "@mars/research-worker";
import type { BrowserFetch, BrowserFetchRequest } from "./engine";

export interface GuardedBrowserFetchOptions {
  fetch: FetchLike;
  resolve: HostResolver;
  signal: AbortSignal;
  allowHosts: readonly string[] | undefined;
  denyHosts: readonly string[];
  maxBytes: number;
  timeoutMs: () => number;
  userAgent: string;
  onBlocked?: (url: string, reason: string) => void;
}

const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "proxy-authorization",
]);
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

/** Classifies a URL the way research does: http(s), public DNS, allow/deny lists. */
export async function browserUrlVerdict(
  raw: string,
  options: Pick<GuardedBrowserFetchOptions, "resolve" | "allowHosts" | "denyHosts">,
): Promise<string | undefined> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "invalid_url";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return "invalid_url";
  if (url.username || url.password) return "invalid_url";
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!hostAllowed(hostname, options.allowHosts, options.denyHosts))
    return "host_denied";
  if (hostnameBlocked(url.hostname)) return "private_address";
  let addresses: string[];
  try {
    addresses = await options.resolve(hostname);
  } catch {
    return "unresolvable_host";
  }
  if (addresses.length === 0) return "unresolvable_host";
  if (addresses.some((address) => isPrivateAddress(address)))
    return "private_address";
  return undefined;
}

/**
 * The only network path pages get: each request (and each redirect hop, which
 * the browser re-issues) is checked before it leaves, bodies are bounded.
 */
export function createGuardedBrowserFetch(
  options: GuardedBrowserFetchOptions,
): BrowserFetch {
  return async (request: BrowserFetchRequest) => {
    const block = (reason: string) => {
      options.onBlocked?.(request.url, reason);
      return { ok: false as const, reason };
    };
    if (options.signal.aborted) return block("cancelled");
    const method = request.method.toUpperCase();
    if (!METHODS.has(method)) return block("method_denied");
    const verdict = await browserUrlVerdict(request.url, options);
    if (verdict) return block(verdict);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (!DROPPED_REQUEST_HEADERS.has(name.toLowerCase())) headers[name] = value;
    }
    headers["user-agent"] = options.userAgent;
    const timeout = AbortSignal.timeout(Math.max(1, options.timeoutMs()));
    let response: Response;
    try {
      const init: RequestInit = {
        method,
        headers,
        redirect: "manual",
        signal: AbortSignal.any([options.signal, timeout]),
      };
      if (request.body && method !== "GET" && method !== "HEAD")
        init.body = request.body as unknown as BodyInit;
      response = await options.fetch(request.url, init);
    } catch {
      return block(options.signal.aborted ? "cancelled" : "network_error");
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > options.maxBytes) {
      await response.body?.cancel().catch(() => {});
      return block("too_large");
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body?.getReader();
    try {
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > options.maxBytes) {
          await reader.cancel().catch(() => {});
          return block("too_large");
        }
        chunks.push(value);
      }
    } catch {
      return block(options.signal.aborted ? "cancelled" : "network_error");
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      if (name !== "set-cookie") responseHeaders[name] = value;
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) responseHeaders["set-cookie"] = cookies.join("\n");
    return { ok: true, status: response.status, headers: responseHeaders, body };
  };
}
