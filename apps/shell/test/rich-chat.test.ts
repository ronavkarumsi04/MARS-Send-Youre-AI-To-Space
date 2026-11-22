import { expect, test } from "bun:test";
import { renderArtifactWorkspace } from "../src/renderer/artifact-view";
import {
  type AssistantViewState,
  renderAssistant,
} from "../src/renderer/assistant-view";
import { createController } from "../src/renderer/controller";
import type { ShellElement } from "../src/renderer/dom";
import {
  chatArtifacts,
  parseMessage,
  renderMarkdown,
} from "../src/renderer/rich-content";
import { findAll, MiniDocument, type MiniElement } from "./mini-dom";
import { fakeBridge, loadFixtureData } from "./test-utils";

const source =
  "## Launch plan\n\nBuild a **small, useful** first version with `Bun`.\n\n1. Explore the repo\n2. Ship a vertical slice\n\n| Phase | Outcome |\n| --- | --- |\n| Build | Working chat |\n\n```typescript src/launch.ts\nexport const launch = true;\n```\n\n```markdown plan.md\n# Launch checklist\n\n- Test the flow\n- Review the diff\n```";

test("rich responses preserve text and extract stable, assistant-only fenced artifacts", () => {
  const messages = [
    { role: "user" as const, content: "```sh\nrm -rf /\n```" },
    { role: "assistant" as const, content: source },
  ];
  const artifacts = chatArtifacts(messages);
  expect(artifacts).toHaveLength(2);
  expect(artifacts[0]).toMatchObject({
    id: "1:0",
    title: "src/launch.ts",
    language: "typescript",
    content: "export const launch = true;",
  });
  expect(artifacts[1]).toMatchObject({
    id: "1:1",
    title: "plan.md",
    language: "markdown",
  });
  expect(
    chatArtifacts([...messages, { role: "user", content: "Next" }])[0]?.id,
  ).toBe("1:0");
  expect(
    parseMessage("Before\n```js\nunfinished").map((block) => block.kind),
  ).toEqual(["markdown", "code"]);
  expect(parseMessage('~~~json\n{"ok": true}\n~~~')[0]).toMatchObject({
    kind: "code",
    language: "json",
  });
});

test("Markdown renders semantic readable blocks but never executes HTML or links", () => {
  const doc = new MiniDocument();
  const hostile =
    '<img src=x onerror="run()">\n\n[open](javascript:run())\n\n<script>run()</script>';
  const rendered = renderMarkdown(
    doc,
    `${source}\n\n${hostile}`,
  ) as MiniElement;
  for (const tag of ["H2", "STRONG", "CODE", "OL", "TABLE", "TH", "TD"]) {
    expect(
      findAll(rendered, (element) => element.tagName === tag).length,
      tag,
    ).toBeGreaterThan(0);
  }
  expect(
    findAll(rendered, (element) =>
      ["IMG", "SCRIPT", "A", "IFRAME"].includes(element.tagName),
    ),
  ).toHaveLength(0);
  expect(rendered.textContent).toContain('<img src=x onerror="run()">');
  expect(rendered.textContent).toContain("[open](javascript:run())");
});

test("chat artifacts open explicitly, preserve user text, and expose an accessible workspace", () => {
  const doc = new MiniDocument();
  let opened = "";
  const state: AssistantViewState = {
    sessions: [
      {
        id: "chat",
        title: "Launch",
        messages: [
          { role: "user", content: "**keep my input literal**" },
          { role: "assistant", content: source },
        ],
      },
    ],
    activeId: "chat",
    draft: "",
    configured: true,
    consent: true,
    busy: false,
    loading: false,
    onArtifact: (id) => {
      opened = id ?? "";
    },
  };
  const view = renderAssistant(doc, state) as MiniElement;
  expect(view.textContent).toContain("**keep my input literal**");
  expect(
    findAll(view, (el) => el.getAttribute("data-artifact-card") !== null),
  ).toHaveLength(2);
  findAll(
    view,
    (el) => el.getAttribute("data-artifact-card") === "1:1",
  )[0]?.click();
  expect(opened).toBe("1:1");
  expect(
    findAll(view, (el) => el.getAttribute("data-artifact-workspace") !== null),
  ).toHaveLength(0);
  const selected = renderAssistant(doc, {
    ...state,
    artifactId: "1:1",
  }) as MiniElement;
  expect(
    findAll(
      selected,
      (el) => el.getAttribute("data-artifact-workspace") !== null,
    ),
  ).toHaveLength(1);
  expect(selected.textContent).toContain("Launch checklist");
});

test("artifact preview does not run code, source is exact, and selection has recovery controls", () => {
  const doc = new MiniDocument();
  const artifact = {
    id: "html",
    title: "index.html",
    language: "html",
    content: '<script>run()</script>\n<img src="x">',
  };
  let closed = false;
  const view = renderArtifactWorkspace(doc, {
    artifacts: [artifact],
    activeId: "html",
    mode: "preview",
    onClose: () => {
      closed = true;
    },
  }) as MiniElement;
  expect(view.textContent).toContain(artifact.content);
  expect(view.textContent).toContain("Source only");
  expect(
    findAll(view, (el) => ["SCRIPT", "IMG", "IFRAME"].includes(el.tagName)),
  ).toHaveLength(0);
  findAll(
    view,
    (el) => el.getAttribute("aria-label") === "Close artifact",
  )[0]?.click();
  expect(closed).toBe(true);
  const document = {
    ...artifact,
    id: "md",
    title: "plan.md",
    language: "markdown",
    content: "# Plan\n\n**Ship it.**",
  };
  const preview = renderArtifactWorkspace(doc, {
    artifacts: [document],
    activeId: "md",
    mode: "preview",
  }) as MiniElement;
  expect(findAll(preview, (el) => el.tagName === "STRONG")).toHaveLength(1);
  const raw = renderArtifactWorkspace(doc, {
    artifacts: [document],
    activeId: "md",
    mode: "source",
  }) as MiniElement;
  expect(raw.textContent).toContain(document.content);
});

test("artifact toolbar round-trip retains the last visible chat scroll and returns to its trigger", async () => {
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
        workspace: "fixture",
        sessions: [
          {
            id: "chat",
            title: "Saved",
            messages: [{ role: "assistant", content: source }],
          },
        ],
      }),
    },
  );
  await ctl.load();
  const field = (key: string) => {
    const el = findAll(
      doc.root,
      (item) => item.getAttribute("data-focus-key") === key,
    )[0];
    if (!el) throw new Error(`Missing ${key}`);
    return el;
  };
  const transcript = () =>
    findAll(
      doc.root,
      (el) => el.getAttribute("data-chat-scroll") !== null,
    )[0] as ShellElement;
  Object.assign(transcript(), {
    clientHeight: 500,
    scrollHeight: 2000,
    scrollTop: 120,
  });
  field("artifacts-toggle").focus();
  field("artifacts-toggle").click();
  // A narrow layout hides the still-mounted conversation. Hidden metrics must
  // not replace its last visible position during a preview/source rerender.
  Object.assign(transcript(), {
    clientHeight: 0,
    scrollHeight: 0,
    scrollTop: 0,
  });
  field("artifact-mode:source").click();
  Object.assign(transcript(), {
    clientHeight: 0,
    scrollHeight: 0,
    scrollTop: 0,
  });
  field("artifact-close").click();
  expect(transcript().scrollTop).toBe(120);
  expect(doc.activeElement?.getAttribute("data-focus-key")).toBe(
    "artifacts-toggle",
  );
  ctl.dispose();
});
