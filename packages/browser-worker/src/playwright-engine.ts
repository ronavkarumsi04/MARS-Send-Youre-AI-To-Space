import { randomBytes } from "node:crypto";
import type { Browser, Page, Route } from "playwright-core";
import {
  type BrowserEngine,
  type BrowserOpenOptions,
  type BrowserSessionHandle,
  NavigationBlockedError,
} from "./engine";

export interface PlaywrightEngineOptions {
  /** Chromium/Chrome binary; MARS never downloads browsers. */
  executablePath: string;
  headless?: boolean;
}

/**
 * Chromium cannot resolve any host itself, so every request must be answered
 * by the route handler, which only uses the worker's guarded fetch. Telemetry,
 * sync, extensions and component updates are off; WebRTC cannot leak UDP.
 */
export const CHROMIUM_LOCKDOWN_ARGS = [
  "--host-resolver-rules=MAP * ~NOTFOUND",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-extensions",
  "--disable-sync",
  "--disable-breakpad",
  "--disable-domain-reliability",
  "--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication",
  "--no-first-run",
  "--no-default-browser-check",
  "--no-pings",
];

const DROPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
]);
const REF = /^e[0-9]{1,5}$/;

/** Real-browser adapter over `playwright-core`; one browser process and profile per session. */
export function createPlaywrightEngine(
  options: PlaywrightEngineOptions,
): BrowserEngine {
  return {
    id: "playwright-chromium",
    async open(open: BrowserOpenOptions): Promise<BrowserSessionHandle> {
      const { chromium } = await import("playwright-core");
      const browser: Browser = await chromium.launch({
        executablePath: options.executablePath,
        headless: options.headless ?? true,
        args: CHROMIUM_LOCKDOWN_ARGS,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      });
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        await browser.close().catch(() => {});
      };
      open.signal.addEventListener("abort", () => void close(), { once: true });
      try {
        const context = await browser.newContext({
          acceptDownloads: false,
          serviceWorkers: "block",
          permissions: [],
          viewport: { width: 1280, height: 800 },
          ...(open.storageState
            ? {
                storageState: JSON.parse(
                  new TextDecoder().decode(open.storageState),
                ),
              }
            : {}),
        });
        let page: Page | undefined;
        const nav: { blocked?: { url: string; reason: string } } = {};
        await context.route("**/*", async (route: Route) => {
          const request = route.request();
          const result = await open.fetch({
            url: request.url(),
            method: request.method(),
            headers: await request.allHeaders(),
            ...(request.postDataBuffer()
              ? { body: new Uint8Array(request.postDataBuffer() as Buffer) }
              : {}),
          });
          if (!result.ok) {
            if (
              request.isNavigationRequest() &&
              request.frame() === page?.mainFrame()
            )
              nav.blocked = { url: request.url(), reason: result.reason };
            await route.abort("blockedbyclient").catch(() => {});
            return;
          }
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(result.headers))
            if (!DROPPED_RESPONSE_HEADERS.has(name)) headers[name] = value;
          await route
            .fulfill({
              status: result.status,
              headers,
              body: Buffer.from(result.body),
            })
            .catch(() => {});
        });
        context.on("page", (opened) => {
          if (page && opened !== page) void opened.close().catch(() => {});
        });
        page = await context.newPage();
        page.setDefaultTimeout(open.actionTimeoutMs);
        page.setDefaultNavigationTimeout(open.actionTimeoutMs * 3);
        page.on("dialog", (dialog) => void dialog.dismiss().catch(() => {}));
        const active = page;
        // Page scripts cannot predict the attribute, so they cannot forge refs.
        const attribute = `data-mars-${randomBytes(8).toString("hex")}`;
        const locate = (ref: string) => {
          if (!REF.test(ref)) throw new Error("Invalid element reference");
          return active.locator(`[${attribute}="${ref}"]`).first();
        };
        const navigate = async (run: () => Promise<unknown>) => {
          delete nav.blocked;
          const raise = () => {
            const blocked = nav.blocked;
            if (blocked)
              throw new NavigationBlockedError(blocked.url, blocked.reason);
          };
          try {
            await run();
          } catch (error) {
            raise();
            throw error;
          }
          raise();
        };
        return {
          page: {
            goto: (url) =>
              navigate(() => active.goto(url, { waitUntil: "load" })),
            async snapshot(limits) {
              const data = await active.evaluate(
                ({ attribute, maxElements, maxTextChars }) => {
                  for (const node of Array.from(
                    document.querySelectorAll(`[${attribute}]`),
                  ))
                    node.removeAttribute(attribute);
                  const selector =
                    "a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=textbox],[contenteditable=true]";
                  const elements: {
                    ref: string;
                    role: string;
                    name: string;
                  }[] = [];
                  for (const node of Array.from(
                    document.querySelectorAll<HTMLElement>(selector),
                  )) {
                    if (elements.length >= maxElements) break;
                    const box = node.getBoundingClientRect();
                    if (box.width === 0 || box.height === 0) continue;
                    const ref = `e${elements.length + 1}`;
                    node.setAttribute(attribute, ref);
                    const tag = node.tagName.toLowerCase();
                    const role =
                      node.getAttribute("role") ??
                      (tag === "a"
                        ? "link"
                        : tag === "input" || tag === "textarea"
                          ? "textbox"
                          : tag);
                    const name = (
                      node.getAttribute("aria-label") ??
                      node.innerText ??
                      node.getAttribute("placeholder") ??
                      node.getAttribute("name") ??
                      ""
                    )
                      .replace(/\s+/g, " ")
                      .trim()
                      .slice(0, 120);
                    elements.push({ ref, role, name });
                  }
                  return {
                    url: location.href,
                    title: document.title,
                    text: (document.body?.innerText ?? "").slice(
                      0,
                      maxTextChars,
                    ),
                    elements,
                  };
                },
                {
                  attribute,
                  maxElements: limits.maxElements,
                  maxTextChars: limits.maxTextChars,
                },
              );
              return data;
            },
            click: (ref) => navigate(() => locate(ref).click()),
            type: async (ref, text) => {
              await locate(ref).fill(text);
            },
            press: (key) =>
              navigate(() =>
                active.keyboard.press(key === "Space" ? " " : key),
              ),
            scroll: async (direction) => {
              await active.mouse.wheel(0, direction === "down" ? 600 : -600);
            },
            back: () => navigate(() => active.goBack({ waitUntil: "load" })),
            screenshot: async () =>
              new Uint8Array(await active.screenshot({ type: "png" })),
            storageState: async () =>
              new TextEncoder().encode(
                JSON.stringify(await context.storageState()),
              ),
          },
          close,
        };
      } catch (error) {
        await close();
        throw error;
      }
    },
  };
}
