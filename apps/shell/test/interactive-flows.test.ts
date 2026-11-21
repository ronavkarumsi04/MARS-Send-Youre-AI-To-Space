import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { serveWorkbench } from "@mars/workbench";
import {
  createFixtureOperations,
  type FixtureData,
} from "../scripts/fixture-workbench";
import { type Bridge, createBridge } from "../src/main/bridge";
import { registerTeamChatBridge } from "../src/main/ipc";
import {
  createTeamChatBridge,
  type TeamChatBridge,
} from "../src/main/team-chat-bridge";
import { createLoopbackTransport } from "../src/main/transport";
import { createController } from "../src/renderer/controller";
import { BRIDGE_METHODS, type ShellBridge } from "../src/shared/methods";
import {
  TEAM_CHAT_CHANNEL,
  TEAM_CHAT_METHODS,
  type TeamChatBridgeApi,
} from "../src/shared/team-chat";
import { findAll, MiniDocument, type MiniElement } from "./mini-dom";
import { loadFixtureData } from "./test-utils";

const TOKEN = "fixture-token-0123456789abcdefghijklmnopqrstuvwxyz";

function toShellBridge(bridge: Bridge): ShellBridge {
  const api: Record<string, (params: unknown) => Promise<unknown>> = {};
  for (const method of BRIDGE_METHODS) {
    api[method] = (params) => bridge.call(method, params);
  }
  return api as unknown as ShellBridge;
}

function toShellTeamChat(teamBridge: TeamChatBridge): TeamChatBridgeApi {
  const api: Record<string, (params: unknown) => Promise<unknown>> = {};
  for (const method of TEAM_CHAT_METHODS) {
    api[method] = (params) => teamBridge.call(method, params);
  }
  return api as unknown as TeamChatBridgeApi;
}

async function startTestWorkbench() {
  const data = (await loadFixtureData()) as FixtureData;
  const server = serveWorkbench({
    api: createFixtureOperations(data),
    token: TOKEN,
    port: 0,
  });
  const url = `http://127.0.0.1:${server.port}`;
  const rawBridge = createBridge({
    transport: createLoopbackTransport({ url, token: TOKEN }),
    connectionScope: {
      owner_id: data.describe.scope.owner_id,
      project_id: data.describe.scope.project_id,
    },
    requestId: () => "interactive-test",
  });
  return {
    data,
    bridge: toShellBridge(rawBridge),
    close: () => server.stop(true),
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

function findByAttr(
  root: MiniElement,
  attr: string,
  value: string,
): MiniElement | undefined {
  return findAll(root, (el) => el.getAttribute(attr) === value)[0];
}

describe("interactive workbench bridge and fixture lifecycle", () => {
  test("creates, starts, steers, cancels, and exports verified patches with SHA-256 verification", async () => {
    const { bridge, close } = await startTestWorkbench();
    try {
      const described = await bridge["workbench.describe"]({});
      expect(described.ok).toBe(true);
      if (!described.ok) return;

      const created = await bridge["tasks.create"]({
        task: {
          schema_version: 1,
          task_id: "fixture-interactive-1",
          session_id: "shell-session-interactive-1",
          scope: described.result.scope,
          request: "Audit interactive bridge <script>alert(1)</script>",
          acceptance_criteria: ["All approvals explicit"],
          budget: {
            max_tokens: 100000,
            max_usd: 2,
            max_duration_ms: 300000,
            max_depth: 2,
            max_concurrency: 1,
          },
          status: "pending",
          revision: 0,
          specialist_revision: null,
          artifacts: [],
        },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.result.task_id).toBe("fixture-interactive-1");
      expect(created.result.status).toBe("pending");

      const staleStart = await bridge["tasks.start"]({
        task_id: "fixture-interactive-1",
        expected_revision: 99,
        approvals: { read: true, write: false, execute: false },
      });
      expect(staleStart.ok).toBe(false);

      const started = await bridge["tasks.start"]({
        task_id: "fixture-interactive-1",
        expected_revision: 0,
        approvals: { read: true, write: true, execute: false },
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      expect(started.result.status).toBe("running");
      expect(started.result.revision).toBe(1);

      const steered = await bridge["tasks.steer"]({
        task_id: "fixture-interactive-1",
        instruction: "Focus on CSP and preload tests",
      });
      expect(steered.ok).toBe(true);

      const cancelled = await bridge["tasks.cancel"]({
        task_id: "fixture-interactive-1",
      });
      expect(cancelled.ok).toBe(true);

      const afterCancel = await bridge["tasks.inspect"]({
        task_id: "fixture-interactive-1",
      });
      expect(afterCancel.ok).toBe(true);
      if (afterCancel.ok) {
        expect(afterCancel.result.status).toBe("cancelled");
      }

      // Unverified completed task must reject export
      const unverifiedExport = await bridge["tasks.export"]({
        task_id: "fixture-completed-unverified",
        expected_revision: "fixture-r4",
        expected_patch_sha256: "a".repeat(64),
      });
      expect(unverifiedExport.ok).toBe(false);

      // Verified task rejects wrong patch digest
      const badHashExport = await bridge["tasks.export"]({
        task_id: "fixture-completed-verified",
        expected_revision: "fixture-r5",
        expected_patch_sha256: "0".repeat(64),
      });
      expect(badHashExport.ok).toBe(false);

      // Verified task succeeds with exact digest
      const diffRes = await bridge["tasks.diff"]({
        task_id: "fixture-completed-verified",
      });
      expect(diffRes.ok).toBe(true);
      if (!diffRes.ok) return;
      const expectedDigest = diffRes.result.digest;
      expect(expectedDigest).toBeDefined();
      if (!expectedDigest) return;

      const exported = await bridge["tasks.export"]({
        task_id: "fixture-completed-verified",
        expected_revision: "fixture-r5",
        expected_patch_sha256: expectedDigest,
      });
      expect(exported.ok).toBe(true);
      if (!exported.ok) return;
      expect(exported.result.patch_sha256).toBe(expectedDigest);
      expect(exported.result.artifact.sha256).toBe(expectedDigest);

      const artifactRes = await bridge["tasks.artifact"]({
        task_id: "fixture-completed-verified",
        artifact: exported.result.artifact,
      });
      expect(artifactRes.ok).toBe(true);
      if (!artifactRes.ok) return;
      const digest = createHash("sha256")
        .update(Buffer.from(artifactRes.result.data_base64, "base64"))
        .digest("hex");
      expect(digest).toBe(expectedDigest);
    } finally {
      close();
    }
  });
});

describe("Team Chat IPC bridge security and operations", () => {
  test("enforces sender origin, allowlist, messaging, reactions, pins, and search", async () => {
    const teamBridge = createTeamChatBridge();
    const handlers = new Map<
      string,
      (
        event: { senderFrame: { url: string } | null },
        payload: unknown,
      ) => Promise<unknown>
    >();
    registerTeamChatBridge(
      {
        handle: (channel, listener) => {
          handlers.set(channel, listener as never);
        },
      },
      teamBridge,
      { trustedOrigin: "mars-shell://app" },
    );
    const handler = handlers.get(TEAM_CHAT_CHANNEL);
    expect(handler).toBeDefined();
    if (!handler) return;

    const untrusted = await handler(
      { senderFrame: { url: "https://evil.example/app" } },
      { method: "team.state", params: {} },
    );
    expect(untrusted).toEqual({
      ok: false,
      code: "forbidden",
    });

    const unknownMethod = await handler(
      { senderFrame: { url: "mars-shell://app/index.html" } },
      { method: "team.deleteEverything", params: {} },
    );
    expect(unknownMethod).toEqual({
      ok: false,
      code: "forbidden",
    });

    const stateRes = (await handler(
      { senderFrame: { url: "mars-shell://app/index.html" } },
      { method: "team.state", params: {} },
    )) as {
      ok: boolean;
      value?: {
        conversations: { conversation_id: string }[];
        users: { user_id: string }[];
      };
    };
    expect(stateRes.ok).toBe(true);
    if (!stateRes.ok || !stateRes.value) return;
    const convId = stateRes.value.conversations[0]?.conversation_id;
    expect(convId).toBeTruthy();
    if (!convId) return;

    const opened = (await handler(
      { senderFrame: { url: "mars-shell://app/index.html" } },
      { method: "team.open", params: { conversation_id: convId } },
    )) as { ok: boolean; value?: { messages: { message_id: string }[] } };
    expect(opened.ok).toBe(true);

    const sent = (await handler(
      { senderFrame: { url: "mars-shell://app/index.html" } },
      {
        method: "team.send",
        params: {
          input: {
            conversation_id: convId,
            body: "Hello from shell test <img src=x onerror=alert(1)>",
            client_message_id: "test-msg-1",
            reply_to: null,
            references: [],
          },
        },
      },
    )) as {
      ok: boolean;
      value?: { message_id: string; sequence: number; duplicate: boolean };
    };
    expect(sent.ok).toBe(true);
    if (!sent.ok || !sent.value) return;
    expect(sent.value.message_id).toBeTruthy();
    expect(sent.value.duplicate).toBe(false);

    const reacted = (await handler(
      { senderFrame: { url: "mars-shell://app/index.html" } },
      {
        method: "team.setReaction",
        params: {
          message_id: sent.value.message_id,
          emoji: "👍",
          on: true,
        },
      },
    )) as { ok: boolean };
    expect(reacted.ok).toBe(true);

    const pinned = (await handler(
      { senderFrame: { url: "mars-shell://app/index.html" } },
      {
        method: "team.setPinned",
        params: {
          conversation_id: convId,
          pinned: true,
        },
      },
    )) as { ok: boolean };
    expect(pinned.ok).toBe(true);

    const searched = (await handler(
      { senderFrame: { url: "mars-shell://app/index.html" } },
      { method: "team.search", params: { query: "Hello from shell test" } },
    )) as { ok: boolean; value?: { hits: unknown[] } };
    expect(searched.ok).toBe(true);
    expect((searched.value?.hits.length ?? 0) > 0).toBe(true);
  });
});

describe("interactive renderer controller flows", () => {
  test("composer, approvals, paid-model consent, steer, cancel, verified patch export, and Team Chat pane", async () => {
    const { bridge, close } = await startTestWorkbench();
    try {
      const teamChat = toShellTeamChat(createTeamChatBridge());
      const doc = new MiniDocument();
      const controller = createController(bridge, doc, doc.root, teamChat);
      await controller.load();

      // 1. Select verified task: enabled export button exports and verifies SHA-256
      const verifiedBtn = findByAttr(
        doc.root,
        "data-task-id",
        "fixture-completed-verified",
      );
      verifiedBtn?.click();
      await waitFor(
        () => findByAttr(doc.root, "data-action", "export-patch") !== undefined,
      );
      const exportBtn = findByAttr(doc.root, "data-action", "export-patch");
      expect(exportBtn).toBeDefined();
      expect(exportBtn?.attributes.has("disabled")).toBe(false);
      exportBtn?.click();
      await waitFor(
        () =>
          findByAttr(doc.root, "data-export-verified", "true") !== undefined,
      );
      const exportResult = findByAttr(doc.root, "data-export-verified", "true");
      expect(exportResult?.textContent).toContain("sha256 verified");

      // 2. Unverified task does not allow patch export
      const unverifiedBtn = findByAttr(
        doc.root,
        "data-task-id",
        "fixture-completed-unverified",
      );
      unverifiedBtn?.click();
      await waitFor(
        () => findByAttr(doc.root, "data-action", "export-patch") === undefined,
      );
      expect(
        findByAttr(doc.root, "data-action", "export-patch"),
      ).toBeUndefined();

      // 3. Pending task: paid-model consent blocks launch until consented, and independent approvals work
      const pendingBtn = findByAttr(
        doc.root,
        "data-task-id",
        "fixture-pending",
      );
      pendingBtn?.click();
      await waitFor(
        () => findByAttr(doc.root, "data-card", "approval-card") !== undefined,
      );

      const modelSelect = findByAttr(doc.root, "data-control", "launch-model");
      expect(modelSelect).toBeDefined();
      if (modelSelect) {
        modelSelect.value = "paid";
        modelSelect.dispatch("change");
      }
      await waitFor(
        () =>
          findByAttr(doc.root, "data-card", "paid-model-consent") !== undefined,
      );
      const startBlocked = findByAttr(doc.root, "data-action", "start-task");
      expect(startBlocked?.attributes.has("disabled")).toBe(true);

      const paidCheckbox = findByAttr(
        doc.root,
        "data-control",
        "launch-paid-consent",
      );
      if (paidCheckbox) {
        paidCheckbox.checked = true;
        paidCheckbox.dispatch("change");
      }
      const readCheckbox = findByAttr(doc.root, "data-control", "launch-read");
      if (readCheckbox) {
        readCheckbox.checked = true;
        readCheckbox.dispatch("change");
      }
      const startReady = findByAttr(doc.root, "data-action", "start-task");
      expect(startReady?.attributes.has("disabled")).toBe(false);
      startReady?.click();
      await waitFor(
        () => findByAttr(doc.root, "data-action", "steer-task") !== undefined,
      );

      // 4. Steer and cancel the running task
      const steerInput = findByAttr(doc.root, "data-control", "steer-input");
      if (steerInput) {
        steerInput.value = "Check CSP headers";
        steerInput.dispatch("input");
      }
      findByAttr(doc.root, "data-action", "steer-task")?.click();
      await waitFor(() =>
        doc.root.textContent.includes("Steering instruction sent."),
      );

      findByAttr(doc.root, "data-action", "cancel-task")?.click();
      await waitFor(() => doc.root.textContent.includes("cancelled"));

      // 5. Prompt composer creates a new task
      const reqInput = findByAttr(doc.root, "data-control", "composer-request");
      if (reqInput) {
        reqInput.value = "Build interactive workbench <svg onload=alert(1)>";
        reqInput.dispatch("input");
      }
      const createBtn = findByAttr(doc.root, "data-action", "create-task");
      createBtn?.click();
      await waitFor(() =>
        doc.root.textContent.includes(
          "Build interactive workbench <svg onload=alert(1)>",
        ),
      );
      const svgs = findAll(doc.root, (el) => el.tagName === "SVG");
      expect(svgs.length).toBe(0);

      // 6. Embedded Team Chat pane opens, sends message, and keeps untrusted HTML inert
      const teamToggle = findByAttr(
        doc.root,
        "data-action",
        "toggle-team-chat",
      );
      expect(teamToggle).toBeDefined();
      expect(teamToggle?.attributes.has("disabled")).toBe(false);
      teamToggle?.click();
      await waitFor(
        () => findByAttr(doc.root, "data-panel", "team-chat") !== undefined,
      );

      const teamComposer = findByAttr(
        doc.root,
        "data-focus-key",
        "team-composer",
      );
      expect(teamComposer).toBeDefined();
      if (teamComposer) {
        teamComposer.value = "Shipping shell update <script>xss()</script>";
        teamComposer.dispatch("input");
      }
      const sendBtn = findAll(
        doc.root,
        (el) => el.tagName === "BUTTON" && el.textContent === "Send message",
      )[0];
      sendBtn?.click();
      await waitFor(() =>
        doc.root.textContent.includes(
          "Shipping shell update <script>xss()</script>",
        ),
      );
      const scripts = findAll(doc.root, (el) => el.tagName === "SCRIPT");
      expect(scripts.length).toBe(0);
    } finally {
      close();
    }
  });

  test("tampered patch export artifact is rejected by renderer SHA-256 verification", async () => {
    const fixture = (await loadFixtureData()) as FixtureData;
    const detail = fixture.details["fixture-completed-verified"];
    const diff = detail?.diff;
    expect(diff).toBeDefined();
    if (!diff) return;

    const tamperedBridge: ShellBridge = {
      "workbench.describe": async () => ({
        ok: true,
        result: fixture.describe,
      }),
      "tasks.list": async () => ({ ok: true, result: fixture.tasks }),
      "tasks.inspect": async ({ task_id }) => {
        const task = fixture.tasks.find((t) => t.task_id === task_id);
        return task
          ? { ok: true, result: task }
          : { ok: false, error: { kind: "not_found", message: "Not found" } };
      },
      "tasks.events": async ({ task_id }) => ({
        ok: true,
        result: fixture.details[task_id]?.events ?? [],
      }),
      "tasks.artifact": async () => ({
        ok: true,
        result: {
          artifact_id: "art-tampered",
          media_type: "text/x-diff",
          data_base64: Buffer.from("tampered diff bytes", "utf8").toString(
            "base64",
          ),
        },
      }),
      "tasks.diff": async ({ task_id }) => {
        const d = fixture.details[task_id]?.diff;
        return d
          ? { ok: true, result: d }
          : { ok: false, error: { kind: "not_found", message: "Not found" } };
      },
      "tasks.verification": async ({ task_id }) => {
        const v = fixture.details[task_id]?.verification;
        return v
          ? { ok: true, result: v }
          : { ok: false, error: { kind: "not_found", message: "Not found" } };
      },
      "tasks.evidence": async ({ task_id }) => {
        const e = fixture.details[task_id]?.evidence;
        return e
          ? { ok: true, result: e }
          : { ok: false, error: { kind: "not_found", message: "Not found" } };
      },
      "tasks.journal": async () => ({ ok: true, result: [] }),
      "tasks.create": async () => ({
        ok: false,
        error: { kind: "refused", message: "refused" },
      }),
      "tasks.start": async () => ({
        ok: false,
        error: { kind: "refused", message: "refused" },
      }),
      "tasks.resume": async () => ({
        ok: false,
        error: { kind: "refused", message: "refused" },
      }),
      "tasks.steer": async () => ({
        ok: false,
        error: { kind: "refused", message: "refused" },
      }),
      "tasks.cancel": async () => ({
        ok: false,
        error: { kind: "refused", message: "refused" },
      }),
      "tasks.export": async () => ({
        ok: true,
        result: {
          candidate: {
            workspace_id: "ws-fixture",
            provider: "local",
            revision: "fixture-r5",
          },
          patch_sha256: diff.digest ?? "0".repeat(64),
          artifact: {
            artifact_id: "art-tampered",
            media_type: "text/x-diff",
            byte_length: 19,
            sha256: diff.digest ?? "0".repeat(64),
          },
          files: diff.files.length,
          verification: "verified",
          verified: true,
          verdict_run_id: "ver-fixture-5",
          round_trip: { status: "passed", reason: null },
          unsupported: [],
        },
      }),
    };

    const doc = new MiniDocument();
    const controller = createController(tamperedBridge, doc, doc.root);
    await controller.load();

    findByAttr(doc.root, "data-task-id", "fixture-completed-verified")?.click();
    await waitFor(
      () => findByAttr(doc.root, "data-action", "export-patch") !== undefined,
    );
    const exportBtn = findByAttr(doc.root, "data-action", "export-patch");
    exportBtn?.click();
    await waitFor(() =>
      doc.root.textContent.includes("failed SHA-256 verification"),
    );
    expect(
      findByAttr(doc.root, "data-export-verified", "true"),
    ).toBeUndefined();
    expect(doc.root.textContent).not.toContain("tampered diff bytes");
  });
});
