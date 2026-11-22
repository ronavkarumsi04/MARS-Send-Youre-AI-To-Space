import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistant } from "../src/main/assistant";
import { createController } from "../src/renderer/controller";
import { settingsActions } from "../src/renderer/settings-actions";
import { findAll, MiniDocument } from "./mini-dom";
import { fakeBridge, loadFixtureData } from "./test-utils";

test("attached workbench without a key explains environment setup without offering a settings window", async () => {
  const doc = new MiniDocument();
  const ctl = createController(
    fakeBridge(await loadFixtureData()),
    doc,
    doc.root,
    undefined,
    {
      request: async () => ({
        ok: true,
        configured: false,
        canConfigure: false,
        sessions: [],
      }),
    },
  );
  await ctl.load();
  expect(doc.root.textContent).toContain("OPENROUTER_API_KEY");
  expect(
    findAll(
      doc.root,
      (el) =>
        el.tagName === "BUTTON" && el.textContent.includes("Connect model"),
    ),
  ).toHaveLength(0);
});

test("changing credentials invalidates a pending turn without blocking the next credential or saving a late reply", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mars-change-key-"));
  try {
    const old = new AbortController();
    let signal = old.signal;
    let key: string | undefined = "first-fixture";
    const started = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<string>();
    const chat = createAssistant({
      directory,
      context: () => ({ workspace: "p", key, signal }),
      complete: async (_messages, token, requestSignal) => {
        if (token !== "first-fixture") return "new reply";
        expect(requestSignal).toBe(old.signal);
        started.resolve();
        return reply.promise;
      },
    });
    const request = {
      action: "send",
      id: randomUUID(),
      text: "old",
      consent: true,
    };
    const pending = chat.call(request);
    await started.promise;
    old.abort();
    signal = new AbortController().signal;
    key = undefined;
    const removed = await chat.call({ ...request, text: "removed" });
    expect(!removed.ok && removed.error).toContain("API key");
    key = "second-fixture";
    expect((await chat.call({ ...request, text: "new" })).ok).toBe(true);
    reply.resolve("stale reply");
    expect((await pending).ok).toBe(false);
    const history = await chat.call({ action: "load" });
    expect(
      history.ok && history.sessions[0]?.messages.map((m) => m.content),
    ).toEqual(["new", "new reply"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("settings gives a browser fallback, preserves invalid input and clears a saved key", async () => {
  const doc = new MiniDocument();
  const controls = {
    input: doc.root,
    status: { textContent: "" },
    save: { disabled: false },
    clear: { disabled: false },
  };
  const actions = settingsActions(
    {
      openKeyPage: async () => {
        throw new Error("no browser");
      },
      setKey: async (key) => (key === "accepted-fixture" ? "saved" : "invalid"),
    },
    controls,
  );
  await actions.openKeyPage();
  expect(controls.status.textContent).toContain("Settings → API Keys");
  controls.input.value = "typo";
  await actions.apply("typo");
  expect(controls.input.value).toBe("typo");
  expect(controls.status.textContent).toContain("Check your key");
  controls.input.value = "accepted-fixture";
  await actions.apply("accepted-fixture");
  expect(controls.input.value).toBe("");
});
