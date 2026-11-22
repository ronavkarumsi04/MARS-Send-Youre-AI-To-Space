import type { AssistantApi } from "../shared/assistant";
import type { ShellBridge } from "../shared/methods";
import type { TeamChatBridgeApi } from "../shared/team-chat";
import { createController } from "./controller";
import type { ShellDocument, ShellElement } from "./dom";
import type { ExtensionsApi } from "./extensions-view";

type ShellGlobal = typeof globalThis & {
  marsWorkbench?: ShellBridge;
  marsTeamChat?: TeamChatBridgeApi;
  marsAssistant?: AssistantApi;
  marsExtensions?: ExtensionsApi;
  document?: ShellDocument;
};

const shell = globalThis as ShellGlobal;
const root = shell.document?.getElementById("app") as
  | ShellElement
  | null
  | undefined;
if (shell.marsWorkbench && shell.document && root) {
  void createController(
    shell.marsWorkbench,
    shell.document,
    root,
    shell.marsTeamChat,
    shell.marsAssistant,
    shell.marsExtensions,
  ).load();
}
