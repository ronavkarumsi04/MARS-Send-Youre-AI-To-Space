import type { ClipboardApi } from "../shared/clipboard";
import {
  h,
  type ShellDocument,
  type ShellElement,
  type ShellText,
} from "./dom";

export type ChatArtifact = {
  id: string;
  title: string;
  language: string;
  content: string;
};
type MessageBlock =
  | { kind: "markdown"; content: string }
  | {
      kind: "code";
      content: string;
      language: string;
      title: string;
      index: number;
    };

const LANGUAGES: Record<string, string> = {
  ts: "TypeScript",
  typescript: "TypeScript",
  tsx: "TSX",
  js: "JavaScript",
  javascript: "JavaScript",
  jsx: "JSX",
  py: "Python",
  python: "Python",
  sh: "Shell",
  bash: "Bash",
  shell: "Shell",
  json: "JSON",
  html: "HTML",
  css: "CSS",
  md: "Markdown",
  markdown: "Markdown",
  sql: "SQL",
  yaml: "YAML",
  yml: "YAML",
  text: "Text",
  diff: "Diff",
  svg: "SVG",
};
export function languageLabel(language: string): string {
  return LANGUAGES[language] ?? (language || "Text");
}

/** A deliberately small Markdown subset. All content goes through text nodes. */
export function parseMessage(text: string): MessageBlock[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MessageBlock[] = [];
  let prose: string[] = [];
  let index = 0;
  const flush = () => {
    if (prose.join("\n").trim())
      blocks.push({ kind: "markdown", content: prose.join("\n") });
    prose = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fence = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence) {
      prose.push(line);
      continue;
    }
    flush();
    const marker = fence[1] ?? "```";
    const info = (fence[2] ?? "").trim();
    const [rawLanguage = "", ...name] = info.split(/\s+/);
    const language = /^[\w#+.-]{1,30}$/.test(rawLanguage)
      ? rawLanguage.toLowerCase()
      : "text";
    const title =
      name
        .join(" ")
        .replace(/^(?:file(?:name)?=)["']?|["']$/g, "")
        .slice(0, 160) || `${languageLabel(language)} snippet`;
    const code: string[] = [];
    for (i++; i < lines.length; i++) {
      const next = lines[i] ?? "";
      const closing = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(next)?.[1];
      if (
        closing &&
        closing[0] === marker[0] &&
        closing.length >= marker.length
      )
        break;
      code.push(next);
    }
    blocks.push({
      kind: "code",
      content: code.join("\n"),
      language,
      title,
      index: index++,
    });
  }
  flush();
  return blocks;
}

export function chatArtifacts(
  messages: readonly { role: string; content: string }[],
): ChatArtifact[] {
  return messages.flatMap((message, messageIndex) =>
    message.role !== "assistant"
      ? []
      : parseMessage(message.content).flatMap((block) =>
          block.kind === "code"
            ? [
                {
                  id: `${messageIndex}:${block.index}`,
                  title: block.title,
                  language: block.language,
                  content: block.content,
                },
              ]
            : [],
        ),
  );
}

function inline(
  doc: ShellDocument,
  text: string,
): (ShellElement | ShellText)[] {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*)/g;
  const nodes: (ShellElement | ShellText)[] = [];
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    nodes.push(doc.createTextNode(text.slice(offset, at)));
    const token = match[0];
    const code = token.startsWith("`");
    const strong = token.startsWith("**") || token.startsWith("__");
    const trim = strong ? 2 : 1;
    nodes.push(
      h(
        doc,
        code ? "code" : strong ? "strong" : "em",
        {},
        token.slice(trim, -trim),
      ),
    );
    offset = at + token.length;
  }
  nodes.push(doc.createTextNode(text.slice(offset)));
  return nodes;
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
const tableRule = (line: string) =>
  line.includes("|") && cells(line).every((cell) => /^:?-{3,}:?$/.test(cell));
const listItem = (line: string) => /^\s*(?:[-*+] |\d+[.)] )(.+)$/.exec(line);
const startsBlock = (line: string) =>
  /^(?:#{1,6}\s|>\s?|\s*(?:[-*+] |\d+[.)] )|\s*(?:---+|\*\*\*+)\s*$)/.test(
    line,
  );

function prose(doc: ShellDocument, text: string): ShellElement[] {
  const lines = text.split("\n");
  const nodes: ShellElement[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.trim()) continue;
    const heading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (heading) {
      nodes.push(
        h(
          doc,
          `h${Math.max(2, Math.min(4, heading[1]?.length ?? 1))}`,
          {},
          ...inline(doc, heading[2] ?? ""),
        ),
      );
      continue;
    }
    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {
      nodes.push(h(doc, "hr", {}));
      continue;
    }
    if (line.startsWith(">")) {
      const quote = [line.replace(/^>\s?/, "")];
      while (lines[i + 1]?.startsWith(">"))
        quote.push((lines[++i] ?? "").replace(/^>\s?/, ""));
      nodes.push(h(doc, "blockquote", {}, ...inline(doc, quote.join("\n"))));
      continue;
    }
    if (line.includes("|") && tableRule(lines[i + 1] ?? "")) {
      const headers = cells(line);
      i++;
      const rows: ShellElement[] = [];
      while (lines[i + 1]?.includes("|")) {
        const row = cells(lines[++i] ?? "");
        rows.push(
          h(
            doc,
            "tr",
            {},
            ...headers.map((_, j) =>
              h(doc, "td", {}, ...inline(doc, row[j] ?? "")),
            ),
          ),
        );
      }
      nodes.push(
        h(
          doc,
          "div",
          {
            class: "rich-table-wrap",
            tabindex: "0",
            "aria-label": "Response table",
          },
          h(
            doc,
            "table",
            {},
            h(
              doc,
              "thead",
              {},
              h(
                doc,
                "tr",
                {},
                ...headers.map((cell) =>
                  h(doc, "th", { scope: "col" }, ...inline(doc, cell)),
                ),
              ),
            ),
            h(doc, "tbody", {}, ...rows),
          ),
        ),
      );
      continue;
    }
    if (listItem(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: ShellElement[] = [];
      let current = line;
      do {
        items.push(
          h(doc, "li", {}, ...inline(doc, listItem(current)?.[1] ?? "")),
        );
        const next = lines[i + 1] ?? "";
        if (!listItem(next) || /^\s*\d/.test(next) !== ordered) break;
        current = lines[++i] ?? "";
      } while (i < lines.length);
      nodes.push(h(doc, ordered ? "ol" : "ul", {}, ...items));
      continue;
    }
    const paragraph = [line];
    while (
      (lines[i + 1] ?? "").trim() &&
      !startsBlock(lines[i + 1] ?? "") &&
      !tableRule(lines[i + 2] ?? "")
    )
      paragraph.push(lines[++i] ?? "");
    nodes.push(h(doc, "p", {}, ...inline(doc, paragraph.join("\n"))));
  }
  return nodes;
}

export function copyButton(
  doc: ShellDocument,
  text: string,
  label = "Copy",
): ShellElement {
  const button = h(
    doc,
    "button",
    { type: "button", class: "copy-action", "aria-label": label },
    label,
  );
  const feedback = h(doc, "span", { class: "copy-feedback", role: "status" });
  button.addEventListener("click", () => {
    void (async () => {
      try {
        const clipboard = (
          globalThis as typeof globalThis & { marsClipboard?: ClipboardApi }
        ).marsClipboard;
        if (!clipboard || !(await clipboard.writeText(text)).ok)
          throw new Error("Clipboard unavailable");
        feedback.textContent = "Copied";
      } catch {
        feedback.textContent =
          "Couldn’t copy. Select the text to copy manually.";
      }
    })();
  });
  return h(doc, "span", { class: "copy-control" }, button, feedback);
}

export function renderSource(
  doc: ShellDocument,
  content: string,
  language: string,
): ShellElement {
  return h(
    doc,
    "div",
    { class: "source-block" },
    h(
      doc,
      "div",
      { class: "source-toolbar" },
      h(doc, "span", {}, languageLabel(language)),
      copyButton(doc, content, "Copy code"),
    ),
    h(
      doc,
      "pre",
      {
        class: "source-code",
        tabindex: "0",
        "aria-label": `${languageLabel(language)} source`,
      },
      h(doc, "code", {}, content),
    ),
  );
}

export function renderMarkdown(
  doc: ShellDocument,
  text: string,
  options?: {
    messageIndex: number;
    onArtifact?: ((id: string) => void) | undefined;
  },
): ShellElement {
  return h(
    doc,
    "div",
    { class: "rich-content" },
    ...parseMessage(text).flatMap((block) => {
      if (block.kind === "markdown") return prose(doc, block.content);
      if (!options) return [renderSource(doc, block.content, block.language)];
      const id = `${options.messageIndex}:${block.index}`;
      const card = h(
        doc,
        "button",
        {
          type: "button",
          class: "artifact-card",
          "data-artifact-card": id,
          "data-focus-key": `artifact:${id}`,
          "aria-label": `Open artifact ${block.title}`,
        },
        h(doc, "span", { class: "file-mark", "aria-hidden": "true" }),
        h(
          doc,
          "span",
          { class: "artifact-card-label" },
          h(doc, "strong", {}, block.title),
          h(
            doc,
            "small",
            {},
            `${languageLabel(block.language)} · ${block.content.split("\n").length} lines`,
          ),
        ),
        h(doc, "span", { class: "artifact-card-open" }, "Open"),
      );
      card.addEventListener("click", () => options.onArtifact?.(id));
      return [card];
    }),
  );
}
