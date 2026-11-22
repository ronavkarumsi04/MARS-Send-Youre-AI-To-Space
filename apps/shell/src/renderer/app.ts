import type { ShellBridge } from "../shared/methods";
import type { TeamChatBridgeApi } from "../shared/team-chat";
import { createController } from "./controller";
import type { ShellDocument, ShellElement } from "./dom";

type ShellGlobal = typeof globalThis & {
  marsWorkbench?: ShellBridge;
  marsTeamChat?: TeamChatBridgeApi;
  document?: ShellDocument;
  addEventListener?: (
    type: "pagehide",
    listener: () => void,
    options: { once: boolean },
  ) => void;
};

const shell = globalThis as ShellGlobal;
const root = shell.document?.getElementById("app") as
  | ShellElement
  | null
  | undefined;
if (shell.marsWorkbench && shell.document && root) {
  const controller = createController(
    shell.marsWorkbench,
    shell.document,
    root,
    shell.marsTeamChat,
  );
  shell.addEventListener?.("pagehide", () => controller.dispose(), {
    once: true,
  });
  void controller.load();
}
