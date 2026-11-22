import { fail } from "@mars/team-chat";
import { ASSISTANT_CHANNEL } from "../shared/assistant";
import { BRIDGE_CHANNEL, bridgeFailure } from "../shared/methods";
import { TEAM_CHAT_CHANNEL } from "../shared/team-chat";
import type { createAssistant } from "./assistant";
import type { Bridge } from "./bridge";
import type { TeamChatBridge } from "./team-chat-bridge";

export type IpcEventLike = {
  sender?: unknown;
  senderFrame?: { url?: string } | null;
};

export type IpcContentsLike = {
  mainFrame: { url?: string };
  isDestroyed(): boolean;
};

type SenderOptions = {
  trustedOrigin: string;
  trustedContents: IpcContentsLike;
  pathname?: string;
};

export type IpcMainLike = {
  handle(
    channel: string,
    listener: (event: IpcEventLike, payload: unknown) => unknown,
  ): void;
};

export function trustedSender(
  event: IpcEventLike,
  { trustedOrigin, trustedContents, pathname }: SenderOptions,
): boolean {
  try {
    if (
      trustedContents.isDestroyed() ||
      event.sender !== trustedContents ||
      event.senderFrame !== trustedContents.mainFrame
    )
      return false;
    const trusted = new URL(trustedOrigin);
    const sender = new URL(event.senderFrame?.url ?? "");
    return (
      sender.protocol === trusted.protocol &&
      sender.host === trusted.host &&
      (pathname === undefined || sender.pathname === pathname) &&
      sender.username === "" &&
      sender.password === ""
    );
  } catch {
    return false;
  }
}

export function registerAssistantBridge(
  ipcMain: IpcMainLike,
  assistant: ReturnType<typeof createAssistant>,
  options: SenderOptions,
): void {
  ipcMain.handle(ASSISTANT_CHANNEL, async (event, payload) => {
    if (!trustedSender(event, { ...options, pathname: "/index.html" }))
      return { ok: false, error: "Chat request refused." };
    try {
      return await assistant.call(payload);
    } catch {
      return { ok: false, error: "Chat is unavailable. Please try again." };
    }
  });
}

function requestPayload(
  payload: unknown,
): { method: unknown; params: unknown } | undefined {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Object.getPrototypeOf(payload) !== Object.prototype
  )
    return undefined;
  const record = payload as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    !Object.hasOwn(record, "method") ||
    !Object.hasOwn(record, "params")
  )
    return undefined;
  return { method: record.method, params: record.params };
}

export function registerBridge(
  ipcMain: IpcMainLike,
  bridge: Bridge,
  options: SenderOptions,
): void {
  ipcMain.handle(BRIDGE_CHANNEL, async (event, payload) => {
    try {
      if (!trustedSender(event, { ...options, pathname: "/index.html" }))
        return bridgeFailure("refused");
      const request = requestPayload(payload);
      if (!request) return bridgeFailure("refused");
      return await bridge.call(request.method, request.params);
    } catch {
      return bridgeFailure("protocol");
    }
  });
}

export function registerTeamChatBridge(
  ipcMain: IpcMainLike,
  teamChat: TeamChatBridge,
  options: SenderOptions,
): void {
  ipcMain.handle(TEAM_CHAT_CHANNEL, async (event, payload) => {
    try {
      if (!trustedSender(event, { ...options, pathname: "/index.html" }))
        return fail("forbidden");
      const request = requestPayload(payload);
      if (!request) return fail("invalid");
      return await teamChat.call(request.method, request.params);
    } catch {
      return fail("unavailable");
    }
  });
}
