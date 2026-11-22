import { expect, test } from "bun:test";
import {
  renderArtifactWorkspace,
  renderTaskArtifacts,
} from "../src/renderer/artifact-view";
import type { ClipboardApi } from "../src/shared/clipboard";
import { findAll, MiniDocument, type MiniElement } from "./mini-dom";

const workspace = (content: string) =>
  renderArtifactWorkspace(new MiniDocument(), {
    artifacts: [{ id: "json", title: "data.json", language: "json", content }],
    activeId: "json",
    mode: "preview",
  }) as MiniElement;
const code = (root: MiniElement) =>
  findAll(root, (el) => el.tagName === "CODE")[0]?.textContent;

test("chat and verified task JSON previews and copies preserve every literal", async () => {
  // Parsing then serializing rounds the ID/fraction, loses -0/duplicate keys,
  // and turns the valid but very large exponent into null.
  const content = String.raw`{"id":9007199254740993,"fraction":1.00000000000000001,"negative":-0,"large":1e400,"same":1,"same":2,"text":"braces: [],{} and quote: \""}`;
  const formatted = String.raw`{
  "id": 9007199254740993,
  "fraction": 1.00000000000000001,
  "negative": -0,
  "large": 1e400,
  "same": 1,
  "same": 2,
  "text": "braces: [],{} and quote: \""
}`;
  const task = renderTaskArtifacts(new MiniDocument(), [
    {
      status: "verified",
      content,
      ref: {
        artifact_id: "data.json",
        sha256: "a".repeat(64),
        byte_length: content.length,
        media_type: "application/json",
      },
    },
  ]) as MiniElement;
  const chat = workspace(content);
  const writes: string[] = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, "marsClipboard");
  Object.defineProperty(globalThis, "marsClipboard", {
    configurable: true,
    value: {
      writeText: async (text) => {
        writes.push(text);
        return { ok: true };
      },
    } satisfies ClipboardApi,
  });
  try {
    for (const view of [chat, task]) {
      expect(code(view)).toBe(formatted);
      findAll(
        view,
        (el) => el.getAttribute("aria-label") === "Copy code",
      )[0]?.click();
    }
    findAll(
      chat,
      (el) => el.getAttribute("aria-label") === "Copy artifact",
    )[0]?.click();
    await Promise.resolve();
    expect(writes).toEqual([formatted, formatted, content]);
  } finally {
    if (previous) Object.defineProperty(globalThis, "marsClipboard", previous);
    else Reflect.deleteProperty(globalThis, "marsClipboard");
  }
});

test("JSON formatting handles nested and empty containers without touching strings", () => {
  const content = String.raw` { "items" : [ {}, [], [true,false,null] ], "escaped": "\\\"[,:}]" } `;
  expect(code(workspace(content))).toBe(String.raw`{
  "items": [
    {},
    [],
    [
      true,
      false,
      null
    ]
  ],
  "escaped": "\\\"[,:}]"
}`);
  for (const primitive of ["null", "true", "123e+40", '"a b"'])
    expect(code(workspace(` \n${primitive} \n`))).toBe(primitive);
});

test("invalid JSON stays exact with an explanation", () => {
  const content = '{ "id": 9007199254740993, }';
  const view = workspace(content);
  expect(code(view)).toBe(content);
  expect(view.textContent).toContain("This isn’t valid JSON");
});

test("deep or whitespace-expanding JSON falls back to original without unbounded formatting", () => {
  for (const content of [
    `${"[".repeat(200)}0${"]".repeat(200)}`,
    "[".repeat(64) + Array(10000).fill("0").join(",") + "]".repeat(64),
  ]) {
    const view = workspace(content);
    expect(code(view)).toBe(content);
    expect(view.textContent).not.toContain("This isn’t valid JSON");
  }
});
