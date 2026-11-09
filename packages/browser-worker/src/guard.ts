import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import {
  type HostResolver,
  hostAllowed,
  hostnameBlocked,
  isPrivateAddress,
} from "@mars/research-worker";
import type { BrowserFetch, BrowserFetchRequest } from "./engine";

/**
 * Sends one request to `address`, the IP the guard resolved and validated for
 * the URL's host, so a second DNS answer can never redirect it (DNS rebinding).
 */
export type PinnedFetch = (
  url: string,
  init: RequestInit,
  address: string,
) => Promise<Response>;

export interface GuardedBrowserFetchOptions {
  fetch: PinnedFetch;
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
const METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);

type UrlCheck = { ok: true; address: string } | { ok: false; reason: string };

/** Resolves a URL's host once and returns the public address to connect to. */
async function checkBrowserUrl(
  raw: string,
  options: Pick<
    GuardedBrowserFetchOptions,
    "resolve" | "allowHosts" | "denyHosts"
  >,
): Promise<UrlCheck> {
  const fail = (reason: string): UrlCheck => ({ ok: false, reason });
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("invalid_url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return fail("invalid_url");
  if (url.username || url.password) return fail("invalid_url");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!hostAllowed(hostname, options.allowHosts, options.denyHosts))
    return fail("host_denied");
  if (hostnameBlocked(url.hostname)) return fail("private_address");
  let addresses: string[];
  if (isIP(hostname)) addresses = [hostname];
  else {
    try {
      addresses = await options.resolve(hostname);
    } catch {
      return fail("unresolvable_host");
    }
  }
  const [address] = addresses;
  if (address === undefined || isIP(address) === 0)
    return fail("unresolvable_host");
  if (addresses.some((candidate) => isPrivateAddress(candidate)))
    return fail("private_address");
  return { ok: true, address };
}

/** Classifies a URL the way research does: http(s), public DNS, allow/deny lists. */
export async function browserUrlVerdict(
  raw: string,
  options: Pick<
    GuardedBrowserFetchOptions,
    "resolve" | "allowHosts" | "denyHosts"
  >,
): Promise<string | undefined> {
  const checked = await checkBrowserUrl(raw, options);
  return checked.ok ? undefined : checked.reason;
}

/**
 * The live PinnedFetch: node:http(s) with a `lookup` that only ever returns
 * the validated address. TLS still verifies the certificate against the URL's
 * hostname (SNI and identity come from the URL, not the address).
 */
export function createPinnedFetch(): PinnedFetch {
  return (url, init, address) =>
    new Promise<Response>((resolve, reject) => {
      const family = isIP(address);
      if (family === 0) {
        reject(new Error("Pinned address is not an IP address."));
        return;
      }
      const target = new URL(url);
      const outgoing: Record<string, string> = {};
      new Headers(init.headers).forEach((value, name) => {
        outgoing[name] = value;
      });
      const client = target.protocol === "https:" ? https : http;
      const lookup = (
        _hostname: string,
        options: { all?: boolean } | undefined,
        callback: (...args: unknown[]) => void,
      ) =>
        options?.all
          ? callback(null, [{ address, family }])
          : callback(null, address, family);
      const request = client.request(
        target,
        {
          method: init.method ?? "GET",
          headers: outgoing,
          ...(init.signal ? { signal: init.signal } : {}),
          lookup: lookup as unknown as http.RequestOptions["lookup"],
        },
        (response) => {
          const status = response.statusCode ?? 0;
          if (status < 200 || status > 599) {
            response.destroy();
            reject(new Error("Unexpected response status."));
            return;
          }
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (value === undefined) continue;
            for (const item of Array.isArray(value) ? value : [value])
              headers.append(name, item);
          }
          const empty =
            status === 204 || status === 304 || init.method === "HEAD";
          if (empty) response.resume();
          resolve(
            new Response(
              empty
                ? null
                : (Readable.toWeb(response) as unknown as ReadableStream),
              { status, headers },
            ),
          );
        },
      );
      request.on("error", reject);
      if (init.body instanceof Uint8Array) request.end(Buffer.from(init.body));
      else request.end();
    });
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
    const checked = await checkBrowserUrl(request.url, options);
    if (!checked.ok) return block(checked.reason);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (!DROPPED_REQUEST_HEADERS.has(name.toLowerCase()))
        headers[name] = value;
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
      response = await options.fetch(request.url, init, checked.address);
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
    return {
      ok: true,
      status: response.status,
      headers: responseHeaders,
      body,
    };
  };
}
