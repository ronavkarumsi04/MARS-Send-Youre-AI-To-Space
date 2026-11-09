import { htmlToText } from "@mars/research-worker";
import {
  type BrowserElement,
  type BrowserEngine,
  type BrowserFetch,
  type BrowserKey,
  type BrowserOpenOptions,
  type BrowserSessionHandle,
  NavigationBlockedError,
} from "./engine";

interface FakeElement extends BrowserElement {
  href?: string;
  submit?: string;
}

interface FakeDocument {
  url: string;
  title: string;
  text: string;
  elements: FakeElement[];
}

export interface FakeBrowserEngineOptions {
  /** Navigations to matching URLs never settle until the session is aborted. */
  hang?: (url: string) => boolean;
  /** Makes `open` fail, e.g. to simulate a missing browser binary. */
  failOpen?: () => Error | undefined;
}

export interface FakeBrowserEngine extends BrowserEngine {
  readonly opened: number;
  readonly closed: number;
  /** Storage state each session started with, as text. */
  readonly startStates: (string | null)[];
  readonly typed: string[];
}

export const FAKE_PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const attr = (tag: string, name: string): string | undefined =>
  tag.match(new RegExp(`\\b${name}="([^"]*)"`, "i"))?.[1];
const plain = (html: string) => htmlToText(`<p>${html}</p>`).text.trim();

function parseDocument(url: string, html: string): FakeDocument {
  const { title, text } = htmlToText(html);
  const elements: FakeElement[] = [];
  const pattern =
    /<a\b([^>]*)>([\s\S]*?)<\/a>|<button\b([^>]*)>([\s\S]*?)<\/button>|<input\b([^>]*)>/gi;
  for (const match of html.matchAll(pattern)) {
    const ref = `e${elements.length + 1}`;
    if (match[1] !== undefined) {
      const href = attr(match[1], "href");
      elements.push({
        ref,
        role: "link",
        name: plain(match[2] ?? ""),
        ...(href ? { href } : {}),
      });
    } else if (match[3] !== undefined) {
      const href = attr(match[3], "data-href");
      elements.push({
        ref,
        role: "button",
        name: plain(match[4] ?? ""),
        ...(href ? { href } : {}),
      });
    } else if (match[5] !== undefined) {
      const submit = attr(match[5], "data-submit");
      elements.push({
        ref,
        role: "textbox",
        name: attr(match[5], "aria-label") ?? attr(match[5], "name") ?? "",
        ...(submit ? { submit } : {}),
      });
    }
  }
  return { url, title, text, elements };
}

/**
 * Deterministic in-process browser for offline tests. Pages are HTML fetched
 * through the same guarded `BrowserFetch` a real engine uses, so egress policy
 * is exercised identically; links, `<button data-href>` and
 * `<input data-submit="...{}...">` (submitted with Enter) are interactive.
 */
export function createFakeBrowserEngine(
  options: FakeBrowserEngineOptions = {},
): FakeBrowserEngine {
  let opened = 0;
  let closed = 0;
  const startStates: (string | null)[] = [];
  const typed: string[] = [];
  const engine: FakeBrowserEngine = {
    id: "fake-browser",
    get opened() {
      return opened;
    },
    get closed() {
      return closed;
    },
    startStates,
    typed,
    async open(open: BrowserOpenOptions): Promise<BrowserSessionHandle> {
      const failure = options.failOpen?.();
      if (failure) throw failure;
      opened += 1;
      const initial = open.storageState
        ? new TextDecoder().decode(open.storageState)
        : null;
      startStates.push(initial);
      const cookies = new Map<string, string>(
        initial ? (JSON.parse(initial) as { cookies: [string, string][] }).cookies : [],
      );
      const fetcher: BrowserFetch = open.fetch;
      let isClosed = false;
      let doc: FakeDocument | undefined;
      const history: string[] = [];
      const values = new Map<string, string>();
      let focused: string | undefined;
      let scrollY = 0;
      const alive = () => {
        if (isClosed || open.signal.aborted) throw new Error("Browser is closed");
      };
      const load = async (target: string, push: boolean): Promise<void> => {
        alive();
        let url = target;
        for (let hop = 0; hop <= 5; hop += 1) {
          if (options.hang?.(url)) {
            await new Promise((_, reject) => {
              const fail = () => reject(new Error("Navigation aborted"));
              if (open.signal.aborted) fail();
              open.signal.addEventListener("abort", fail, { once: true });
            });
          }
          const cookieHeader = [...cookies]
            .map(([name, value]) => `${name}=${value}`)
            .join("; ");
          const result = await fetcher({
            url,
            method: "GET",
            headers: cookieHeader ? { cookie: cookieHeader } : {},
          });
          alive();
          if (!result.ok) throw new NavigationBlockedError(url, result.reason);
          for (const line of (result.headers["set-cookie"] ?? "").split("\n")) {
            const pair = line.split(";")[0]?.split("=");
            if (pair?.[0] && pair[1] !== undefined)
              cookies.set(pair[0].trim(), pair[1].trim());
          }
          const location = result.headers.location;
          if (result.status >= 300 && result.status < 400 && location) {
            url = new URL(location, url).href;
            continue;
          }
          if (push && doc) history.push(doc.url);
          doc = parseDocument(url, new TextDecoder().decode(result.body));
          values.clear();
          focused = undefined;
          scrollY = 0;
          return;
        }
        throw new NavigationBlockedError(url, "too_many_redirects");
      };
      const element = (ref: string): FakeElement => {
        alive();
        const found = doc?.elements.find((candidate) => candidate.ref === ref);
        if (!found) throw new Error(`No element ${ref} on the page`);
        return found;
      };
      const resolve = (href: string) => new URL(href, doc?.url).href;
      const session: BrowserSessionHandle = {
        page: {
          goto: (url) => load(url, true),
          async snapshot(limits) {
            alive();
            if (!doc) return { url: "about:blank", title: "", text: "", elements: [] };
            return {
              url: doc.url,
              title: doc.title,
              text: doc.text.slice(0, limits.maxTextChars),
              elements: doc.elements
                .slice(0, limits.maxElements)
                .map(({ ref, role, name }) => ({ ref, role, name })),
            };
          },
          async click(ref) {
            const target = element(ref);
            if (target.role === "textbox") focused = ref;
            else if (target.href) await load(resolve(target.href), true);
          },
          async type(ref, text) {
            const target = element(ref);
            if (target.role !== "textbox") throw new Error("Element is not editable");
            typed.push(text);
            values.set(ref, text);
            focused = ref;
          },
          async press(key: BrowserKey) {
            alive();
            if (key !== "Enter" || !focused) return;
            const target = element(focused);
            if (target.submit)
              await load(
                resolve(
                  target.submit.replace(
                    "{}",
                    encodeURIComponent(values.get(focused) ?? ""),
                  ),
                ),
                true,
              );
          },
          async scroll(direction) {
            alive();
            scrollY = Math.max(0, scrollY + (direction === "down" ? 600 : -600));
          },
          async back() {
            alive();
            const previous = history.pop();
            if (previous) await load(previous, false);
          },
          async screenshot() {
            alive();
            const marker = new TextEncoder().encode(
              `fake:${doc?.url ?? "about:blank"}:${scrollY}`,
            );
            const bytes = new Uint8Array(FAKE_PNG_SIGNATURE.length + marker.length);
            bytes.set(FAKE_PNG_SIGNATURE);
            bytes.set(marker, FAKE_PNG_SIGNATURE.length);
            return bytes;
          },
          async storageState() {
            alive();
            return new TextEncoder().encode(JSON.stringify({ cookies: [...cookies] }));
          },
        },
        async close() {
          if (isClosed) return;
          isClosed = true;
          closed += 1;
        },
      };
      open.signal.addEventListener("abort", () => void session.close(), {
        once: true,
      });
      return session;
    },
  };
  return engine;
}
