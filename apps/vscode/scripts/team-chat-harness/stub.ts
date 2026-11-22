/// <reference lib="dom" />
// Browser-side stand-in for the VS Code webview API: routes webview messages to
// an in-page TeamChatController over the fixture and posts its state back.
// Dev harness only; never bundled into the extension.
import { TeamClient } from "../../src/teamChat/client";
import { TeamChatController } from "../../src/teamChat/controller";
import { TeamRealtime } from "../../src/teamChat/realtime";
import { RpcTeamService } from "../../src/teamChat/service";
import {
  FakeTeamServer,
  fakeHandoffWorkbench,
  HANDOFF_CAPABILITIES,
} from "../../test/teamFixtures";

const params = new URLSearchParams(window.location.search);
export const scenario = params.get("scenario") ?? "inbox";

/** What outlives a webview reload: the team server, the Workbench and the saved webview state. */
interface Shared {
  server: FakeTeamServer;
  workbench: ReturnType<typeof fakeHandoffWorkbench>;
  saved: unknown;
}
const prior = (globalThis as { __harnessShared?: Shared }).__harnessShared;
/** True in the second evaluation of this bundle, after `reloadWebview`. */
export const reloaded = prior !== undefined;
let saved: unknown = prior?.saved;
/** False once this evaluation's webview was replaced; its late messages are dropped. */
let live = true;

/**
 * The "service" scenario drives the real `RpcTeamService` + `TeamRealtime`
 * against an in-page stubbed team server (no network, no token outside this
 * page): the same code path the extension host runs.
 */
function seed(server: FakeTeamServer): void {
  server.seedDm("user_ada", "user_grace", [
    "Hi Ada, the launch key evidence is in the review now.",
    "Thanks! Looking at it this afternoon.",
    "The verdict layout lives host-side; chips stay restricted until refs land.",
  ]);
  server.seedGroup(
    "Release room",
    ["user_ada", "user_grace", "user_linus"],
    [
      "Release checklist is at #4. @MARS can summarize later.",
      "Pinning this one for the week.",
    ],
  );
}

function serviceController(): TeamChatController {
  const handoff = scenario === "handoff";
  const server =
    prior?.server ??
    new FakeTeamServer(handoff ? { capabilities: HANDOFF_CAPABILITIES } : {});
  const workbench = prior?.workbench ?? fakeHandoffWorkbench();
  Object.assign(globalThis, {
    __harnessShared: { server, workbench, saved } satisfies Shared,
  });
  if (!prior) seed(server);
  const client = new TeamClient(server.transport("user_ada"));
  const service = new RpcTeamService(client);
  let controller: TeamChatController | undefined;
  const realtime = new TeamRealtime({
    client,
    streamUrl: null,
    streamSupported: () => false,
    getToken: () => Promise.resolve("harness-token-not-a-secret"),
    onEvent: (event) =>
      controller?.notifyDelivery(
        event.conversation_id,
        event.kind,
        event.message_seq,
      ),
    onStatus: (state) => controller?.notifyConnection(state),
    onResync: () =>
      controller?.handleMessage({ type: "ready" }).then(() => undefined),
    pollIntervalMs: 200,
  });
  controller = new TeamChatController({
    post: (state) => window.postMessage({ type: "state", state }, "*"),
    service,
    realtime,
    viewer: "service",
    ...(handoff ? { workbench: () => workbench } : {}),
    pageSize: 50,
  });
  Object.assign(globalThis, {
    __teamServer: server,
    __runLinkedTasks: () => {
      for (const taskId of workbench.tasks.keys()) workbench.run(taskId);
    },
  });
  return controller;
}

export const controller =
  scenario === "service" || scenario === "handoff"
    ? serviceController()
    : new TeamChatController({
        post: (state) => window.postMessage({ type: "state", state }, "*"),
        sendDelayMs: scenario === "pending" ? 60_000 : 0,
      });

Object.assign(globalThis, {
  acquireVsCodeApi: () => ({
    postMessage: (message: unknown) => {
      if (live) void controller.handleMessage(message);
    },
    getState: () => saved,
    setState: (state: unknown) => {
      if (!live) return;
      saved = state;
      const shared = (globalThis as { __harnessShared?: Shared })
        .__harnessShared;
      if (shared) shared.saved = state;
    },
  }),
});

/**
 * Reload the webview as VS Code does: drop the DOM and every module variable,
 * then run the bundle again with only `getState()` and the server carried over.
 * The extension-host controller is recreated too, so nothing it held survives.
 */
export function reloadWebview(): void {
  live = false;
  controller.dispose();
  const app = document.getElementById("app");
  const bundle = document.querySelector<HTMLScriptElement>("script[src]");
  if (!app || !bundle) throw new Error("harness: nothing to reload");
  app.replaceWith(app.cloneNode(false));
  const script = document.createElement("script");
  script.nonce = bundle.nonce ?? "";
  script.src = bundle.src;
  document.body.append(script);
}
