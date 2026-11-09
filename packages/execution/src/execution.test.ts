import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import { EXECUTION_PACKAGE_VERSION, probeExecution } from "./index";

test("execution package version matches every pinned Oh My Pi dependency", async () => {
  const manifest = await Bun.file(
    new URL("../package.json", import.meta.url),
  ).json();
  const pins = Object.entries(manifest.dependencies as Record<string, string>)
    .filter(([name]) => name.startsWith("@oh-my-pi/"))
    .map(([, version]) => version);
  expect(pins.length).toBeGreaterThan(0);
  for (const pin of pins) expect(pin).toBe(EXECUTION_PACKAGE_VERSION);
});

test("initializes the actual SDK and native addon without tools or model calls", async () => {
  expect(await probeExecution()).toEqual({
    runtime: "oh-my-pi",
    package_version: EXECUTION_PACKAGE_VERSION,
    session_initialized: true,
    executable_tools: [],
    persistent_session: false,
    native_search_matches: 1,
    model_requests: 0,
  });
}, 30_000);

test("the upstream journal persists a custom entry and can reopen it", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "mars-journal-probe-"));
  try {
    const writer = SessionManager.create(fixture, join(fixture, "sessions"));
    const entryId = writer.appendCustomEntry("mars.probe", {
      marker: "roundtrip",
    });
    await writer.ensureOnDisk();
    const file = writer.getSessionFile();
    if (!file) throw new Error("Missing session journal path");
    await writer.close();
    const reader = await SessionManager.open(file);
    try {
      const entry = reader
        .getEntries()
        .find((candidate) => candidate.id === entryId);
      expect(entry?.type).toBe("custom");
      if (entry?.type !== "custom") throw new Error("Persisted entry missing");
      expect(entry.data).toEqual({ marker: "roundtrip" });
    } finally {
      await reader.close();
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
