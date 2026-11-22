import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  createRendererRecovery,
  RENDERER_RECOVERY_HTML,
} from "../src/main/renderer-recovery";
import { appResponseHeaders, resolveAppAsset } from "../src/main/security";

test("recovery page uses readable theme colors through a CSP-allowed stylesheet", async () => {
  const href = RENDERER_RECOVERY_HTML.match(
    /<link rel="stylesheet" href="([^"]+)"/,
  )?.[1];
  expect(href).toBe("./shell.css");
  const url = new URL(href ?? "", "mars-shell://app/recovery.html");
  expect(url.origin).toBe(new URL("mars-shell://app/recovery.html").origin);
  expect(resolveAppAsset(url.href)?.mediaType).toBe("text/css; charset=utf-8");
  const policy = appResponseHeaders()["Content-Security-Policy"];
  expect(policy.split("; ").find((rule) => rule.startsWith("style-src"))).toBe(
    "style-src 'self'",
  );
  expect(policy).not.toContain("unsafe-inline");
  expect(RENDERER_RECOVERY_HTML).not.toMatch(/<style\b|\sstyle\s*=|<script\b/i);
  const css = await readFile(
    new URL("../src/renderer/shell.css", import.meta.url),
    "utf8",
  );
  const root = css.match(/:root\s*\{([^}]+)\}/)?.[1] ?? "";
  expect(root).toContain("--fg: #ece6dc;");
  expect(root).toContain("--pageBg: #050407;");
  expect(root).toContain("color: var(--fg);");
  expect(root).toContain("background: var(--pageBg);");
});

test("renderer recovery reloads crashes, caps retries, and leaves a static terminal state", () => {
  const actions: string[] = [];
  const reasons: string[] = [];
  const recover = createRendererRecovery({
    reload: () => actions.push("reload"),
    showRecovery: () => actions.push("recovery"),
    log: (reason) => reasons.push(reason),
    isClosing: () => false,
    now: () => 0,
  });
  recover("clean-exit");
  expect(actions).toEqual([]);
  for (const reason of ["crashed", "oom", "unresponsive", "crashed", "crashed"])
    recover(reason);
  expect(actions).toEqual(["reload", "reload", "reload", "recovery"]);
  expect(reasons).toEqual(["crashed", "oom", "unresponsive", "crashed"]);
});

test("renderer recovery expires the reload window and ignores shutdown or destroyed windows", () => {
  let time = 0;
  let closing = false;
  const actions: string[] = [];
  const recover = createRendererRecovery({
    reload: () => actions.push("reload"),
    showRecovery: () => actions.push("recovery"),
    log: () => {},
    isClosing: () => closing,
    now: () => time,
  });
  for (let index = 0; index < 3; index++) recover("crashed");
  time = 60_000;
  recover("crashed");
  expect(actions).toEqual(["reload", "reload", "reload", "reload"]);
  closing = true;
  recover("crashed");
  expect(actions).toHaveLength(4);
});
