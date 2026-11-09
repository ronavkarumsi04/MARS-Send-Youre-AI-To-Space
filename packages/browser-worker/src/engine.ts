import type { BROWSER_KEYS } from "@mars/browser";

export type BrowserKey = (typeof BROWSER_KEYS)[number];

export interface BrowserElement {
  /** Worker-assigned reference, valid until the next snapshot. */
  ref: string;
  role: string;
  name: string;
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  text: string;
  elements: BrowserElement[];
}

export interface BrowserFetchRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}

export type BrowserFetchResult =
  | {
      ok: true;
      status: number;
      headers: Record<string, string>;
      body: Uint8Array;
    }
  | { ok: false; reason: string };

/**
 * Every request a page makes (documents, subresources, form posts) goes through
 * this function; engines must not reach the network any other way.
 */
export type BrowserFetch = (
  request: BrowserFetchRequest,
) => Promise<BrowserFetchResult>;

/** Raised when the guarded fetch refused a top-level navigation. */
export class NavigationBlockedError extends Error {
  readonly reason: string;
  constructor(url: string, reason: string) {
    super(`Navigation to ${url} was blocked: ${reason}`);
    this.name = "NavigationBlockedError";
    this.reason = reason;
  }
}

export interface BrowserPage {
  goto(url: string): Promise<void>;
  snapshot(limits: {
    maxTextChars: number;
    maxElements: number;
  }): Promise<BrowserSnapshot>;
  click(ref: string): Promise<void>;
  type(ref: string, text: string): Promise<void>;
  press(key: BrowserKey): Promise<void>;
  scroll(direction: "up" | "down"): Promise<void>;
  back(): Promise<void>;
  screenshot(): Promise<Uint8Array>;
  /** Cookies and local storage, for an intentionally shared session. */
  storageState(): Promise<Uint8Array>;
}

export interface BrowserSessionHandle {
  readonly page: BrowserPage;
  /** Kills the browser this session owns; safe to call more than once. */
  close(): Promise<void>;
}

export interface BrowserOpenOptions {
  fetch: BrowserFetch;
  signal: AbortSignal;
  storageState?: Uint8Array;
  actionTimeoutMs: number;
}

/** Adapter over a real or fake browser; each `open` is an isolated profile. */
export interface BrowserEngine {
  readonly id: string;
  open(options: BrowserOpenOptions): Promise<BrowserSessionHandle>;
}
