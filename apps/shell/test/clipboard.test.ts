import { expect, test } from "bun:test";
import { type IpcEventLike, registerClipboardBridge } from "../src/main/ipc";
import { CLIPBOARD_CHANNEL, MAX_COPY_LENGTH } from "../src/shared/clipboard";
import { ipcFixture } from "./ipc-fixture";

test("clipboard is write-only, bounded, and restricted to the owning live main frame", async () => {
  const { options, owner, otherWindow, childFrame } = ipcFixture();
  const writes: string[] = [];
  let listener:
    | ((event: IpcEventLike, payload: unknown) => unknown)
    | undefined;
  registerClipboardBridge(
    {
      handle(channel, callback) {
        expect(channel).toBe(CLIPBOARD_CHANNEL);
        listener = callback;
      },
    },
    (text) => {
      writes.push(text);
    },
    options,
  );
  for (const event of [
    otherWindow,
    childFrame,
    { sender: owner.sender, senderFrame: null },
  ])
    expect(await listener?.(event, "refused")).toEqual({ ok: false });
  for (const payload of [
    null,
    2,
    {},
    { text: "no" },
    "x".repeat(MAX_COPY_LENGTH + 1),
  ])
    expect(await listener?.(owner, payload)).toEqual({ ok: false });
  owner.senderFrame.url = "mars-shell://app/settings.html";
  expect(await listener?.(owner, "wrong page")).toEqual({ ok: false });
  owner.senderFrame.url = "https://evil.example/index.html";
  expect(await listener?.(owner, "wrong origin")).toEqual({ ok: false });
  expect(writes).toEqual([]);
  owner.senderFrame.url = "mars-shell://app/index.html";
  const text = "<script>inert()</script>\n  exact source\n";
  expect(await listener?.(owner, text)).toEqual({ ok: true });
  expect(writes).toEqual([text]);
});

test("native clipboard failures are reported without exposing native errors", async () => {
  const { options, owner } = ipcFixture();
  let listener:
    | ((event: IpcEventLike, payload: unknown) => unknown)
    | undefined;
  registerClipboardBridge(
    {
      handle(_channel, callback) {
        listener = callback;
      },
    },
    () => {
      throw new Error("native clipboard detail");
    },
    options,
  );
  expect(await listener?.(owner, "text")).toEqual({ ok: false });
});
