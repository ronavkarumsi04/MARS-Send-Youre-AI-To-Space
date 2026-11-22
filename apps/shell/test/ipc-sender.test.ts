import { expect, test } from "bun:test";
import {
  type IpcEventLike,
  registerBridge,
  registerTeamChatBridge,
  trustedSender,
} from "../src/main/ipc";

test.each(["workbench", "team"])(
  "%s IPC rejects same-origin wrong windows, subframes, missing frames, and destroyed contents",
  async (kind) => {
    const frame = { url: "mars-shell://app/index.html" };
    let destroyed = false;
    const contents = { mainFrame: frame, isDestroyed: () => destroyed };
    let calls = 0;
    let handle:
      | ((event: IpcEventLike, payload: unknown) => unknown)
      | undefined;
    const ipc = {
      handle: (_channel: string, listener: NonNullable<typeof handle>) => {
        handle = listener;
      },
    };
    const options = {
      trustedOrigin: "mars-shell://app",
      trustedContents: contents,
    };
    if (kind === "workbench")
      registerBridge(
        ipc,
        {
          call: async () => {
            calls++;
            return { ok: true, result: {} };
          },
        },
        options,
      );
    else
      registerTeamChatBridge(
        ipc,
        {
          call: async () => {
            calls++;
            return { ok: true, value: {} };
          },
        },
        options,
      );
    const payload = {
      method: kind === "workbench" ? "tasks.list" : "team.state",
      params: {},
    };
    for (const event of [
      { sender: { ...contents }, senderFrame: frame },
      { sender: contents, senderFrame: { ...frame } },
      { sender: contents, senderFrame: null },
      { senderFrame: frame },
    ]) {
      expect(await handle?.(event, payload)).toMatchObject({ ok: false });
    }
    expect(calls).toBe(0);
    const valid = { sender: contents, senderFrame: frame };
    expect(await handle?.(valid, payload)).toMatchObject({ ok: true });
    frame.url = "https://evil.example/index.html";
    expect(await handle?.(valid, payload)).toMatchObject({ ok: false });
    frame.url = "mars-shell://app/index.html";
    destroyed = true;
    expect(await handle?.(valid, payload)).toMatchObject({ ok: false });
    expect(calls).toBe(1);
  },
);

test("settings sender identity is restricted to its own live main frame", () => {
  const mainFrame = { url: "mars-shell://app/settings.html" };
  const settings = { mainFrame, isDestroyed: () => false };
  const options = {
    trustedOrigin: "mars-shell://app",
    trustedContents: settings,
  };
  expect(
    trustedSender({ sender: settings, senderFrame: mainFrame }, options),
  ).toBe(true);
  expect(
    trustedSender({ sender: { ...settings }, senderFrame: mainFrame }, options),
  ).toBe(false);
  expect(
    trustedSender({ sender: settings, senderFrame: { ...mainFrame } }, options),
  ).toBe(false);
  expect(trustedSender({ sender: settings, senderFrame: null }, options)).toBe(
    false,
  );
});
