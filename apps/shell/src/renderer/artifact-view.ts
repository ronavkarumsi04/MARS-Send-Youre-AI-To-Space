import type { ArtifactRef } from "@mars/contracts";
import { disclosure, h, type ShellDocument, type ShellElement } from "./dom";
import {
  type ChatArtifact,
  copyButton,
  languageLabel,
  renderMarkdown,
  renderSource,
} from "./rich-content";
import { untrusted } from "./untrusted";

export type ArtifactView = {
  ref: ArtifactRef;
  content?: string;
  status: "verified" | "rejected" | "not rendered";
  message?: string;
};
export type ArtifactMode = "preview" | "source";
type ArtifactWorkspaceState = {
  artifacts: ChatArtifact[];
  activeId: string;
  mode: ArtifactMode;
  onSelect?: ((id: string) => void) | undefined;
  onMode?: ((mode: ArtifactMode) => void) | undefined;
  onClose?: (() => void) | undefined;
};

function previewKind(language: string): "document" | "json" | "source" {
  if (["markdown", "md"].includes(language)) return "document";
  if (language === "json") return "json";
  return "source";
}

/** Validate JSON, but format its tokens rather than round-tripping JS values.
 * That would round numbers and discard duplicate keys in untrusted files. */
function formatJson(content: string): string {
  JSON.parse(content);
  const tokens =
    content.match(/"(?:\\.|[^"\\])*"|[{}[\],:]|[^\s{}[\],:]+/g) ?? [];
  let depth = 0;
  let formatted = "";
  const newline = () => `\n${"  ".repeat(depth)}`;
  for (const [i, token] of tokens.entries()) {
    if (token === "{" || token === "[") {
      formatted += token;
      // Pretty-printing must not amplify deeply nested/untrusted input.
      if (++depth > 64) return content;
      if (tokens[i + 1] !== (token === "{" ? "}" : "]")) formatted += newline();
    } else if (token === "}" || token === "]") {
      depth--;
      if (tokens[i - 1] !== (token === "}" ? "{" : "[")) formatted += newline();
      formatted += token;
    } else if (token === ",") formatted += `,${newline()}`;
    else if (token === ":") formatted += ": ";
    else formatted += token;
    if (formatted.length > 1_000_000) return content;
  }
  return formatted;
}

function preview(doc: ShellDocument, artifact: ChatArtifact): ShellElement {
  const kind = previewKind(artifact.language);
  if (kind === "document")
    return h(
      doc,
      "div",
      { class: "artifact-document" },
      renderMarkdown(doc, artifact.content),
    );
  if (kind === "json") {
    try {
      return renderSource(doc, formatJson(artifact.content), "json");
    } catch {
      return h(
        doc,
        "div",
        {},
        h(
          doc,
          "p",
          { class: "artifact-note", role: "status" },
          "This isn’t valid JSON. Showing the original source.",
        ),
        renderSource(doc, artifact.content, "json"),
      );
    }
  }
  return renderSource(doc, artifact.content, artifact.language);
}

export function renderArtifactWorkspace(
  doc: ShellDocument,
  state: ArtifactWorkspaceState,
): ShellElement {
  const artifact =
    state.artifacts.find((item) => item.id === state.activeId) ??
    state.artifacts[0];
  const heading = h(
    doc,
    "h2",
    {
      id: "artifact-heading",
      tabindex: "-1",
      "data-artifact-heading": "true",
      "data-focus-key": "artifact-heading",
    },
    artifact?.title ?? "Artifacts",
  );
  const close = h(
    doc,
    "button",
    {
      type: "button",
      class: "artifact-close",
      "aria-label": "Close artifact",
      "data-focus-key": "artifact-close",
    },
    h(doc, "span", { class: "close-mark", "aria-hidden": "true" }),
  );
  close.addEventListener("click", () => state.onClose?.());
  const root = h(
    doc,
    "aside",
    {
      class: "artifact-workspace",
      "data-artifact-workspace": "true",
      "aria-labelledby": "artifact-heading",
    },
    h(
      doc,
      "header",
      { class: "artifact-workspace-header" },
      h(doc, "span", { class: "file-mark", "aria-hidden": "true" }),
      heading,
      close,
    ),
  );
  root.addEventListener("keydown", (event) => {
    if ((event as typeof event & { key?: string }).key === "Escape") {
      event.preventDefault?.();
      state.onClose?.();
    }
  });
  if (!artifact) {
    root.append(
      h(
        doc,
        "p",
        { class: "artifact-note" },
        "Code and documents from MARS will appear here.",
      ),
    );
    return root;
  }
  if (state.artifacts.length > 1) {
    const select = h(
      doc,
      "select",
      {
        class: "artifact-select",
        "aria-label": "Choose artifact",
        "data-focus-key": "artifact-select",
      },
      ...state.artifacts.map((item) =>
        h(
          doc,
          "option",
          { value: item.id, selected: item.id === artifact.id },
          item.title,
        ),
      ),
    );
    select.value = artifact.id;
    select.addEventListener("change", () =>
      state.onSelect?.(select.value ?? artifact.id),
    );
    root.append(
      h(
        doc,
        "div",
        { class: "artifact-switcher" },
        select,
        h(
          doc,
          "span",
          { class: "muted" },
          `${state.artifacts.length} artifacts`,
        ),
      ),
    );
  }
  const kind = previewKind(artifact.language);
  const modeButton = (mode: ArtifactMode, label: string) => {
    const button = h(
      doc,
      "button",
      {
        type: "button",
        class: "artifact-mode",
        "aria-pressed": String(state.mode === mode),
        "data-focus-key": `artifact-mode:${mode}`,
      },
      label,
    );
    button.addEventListener("click", () => state.onMode?.(mode));
    return button;
  };
  root.append(
    h(
      doc,
      "div",
      { class: "artifact-toolbar" },
      h(
        doc,
        "div",
        {
          class: "artifact-modes",
          role: "group",
          "aria-label": "Artifact view",
        },
        modeButton("preview", kind === "source" ? "Code" : "Preview"),
        modeButton("source", "Source"),
      ),
      copyButton(doc, artifact.content, "Copy artifact"),
    ),
    h(
      doc,
      "div",
      {
        class: `artifact-canvas${state.mode === "source" || kind !== "document" ? " is-source" : ""}`,
        "data-scroll-key": `artifact:${artifact.id}:${state.mode}`,
      },
      state.mode === "source"
        ? renderSource(doc, artifact.content, artifact.language)
        : preview(doc, artifact),
    ),
    h(
      doc,
      "footer",
      { class: "artifact-status" },
      h(doc, "span", {}, languageLabel(artifact.language)),
      h(doc, "span", {}, `${artifact.content.split("\n").length} lines`),
      h(
        doc,
        "span",
        {},
        kind === "source" ? "Source only · not executed" : "Read-only preview",
      ),
    ),
  );
  return root;
}

function mediaLanguage(mediaType: string): string {
  const media = mediaType.split(";")[0]?.toLowerCase();
  if (media === "text/markdown") return "markdown";
  if (media === "application/json") return "json";
  return media?.split("/")[1] ?? "text";
}

export function renderTaskArtifacts(
  doc: ShellDocument,
  artifacts: ArtifactView[],
): ShellElement {
  return h(
    doc,
    "section",
    { class: "inspector-section task-artifacts" },
    h(
      doc,
      "h2",
      {},
      "Artifacts",
      h(doc, "span", { class: "artifact-count" }, String(artifacts.length)),
    ),
    ...(artifacts.length
      ? artifacts.map((artifact) => {
          const { ref } = artifact;
          const verified =
            artifact.status === "verified" && artifact.content !== undefined;
          const language = mediaLanguage(ref.media_type);
          const content = verified
            ? h(
                doc,
                "div",
                {
                  class: "verified-artifact-content",
                  "data-provenance": `artifact ${ref.artifact_id} · sha256 verified`,
                },
                h(
                  doc,
                  "p",
                  { class: "artifact-note" },
                  "SHA-256 verified · untrusted content",
                ),
                preview(doc, {
                  id: ref.artifact_id,
                  title: ref.artifact_id,
                  language,
                  content: artifact.content ?? "",
                }),
                disclosure(
                  doc,
                  "artifact-raw",
                  `artifact-source:${ref.artifact_id}`,
                  "Original source",
                  untrusted(
                    doc,
                    artifact.content ?? "",
                    `artifact ${ref.artifact_id} · sha256 verified`,
                  ),
                ),
              )
            : h(
                doc,
                "p",
                { class: artifact.status === "rejected" ? "error" : "muted" },
                artifact.status === "rejected"
                  ? "rejected: sha256 mismatch"
                  : (artifact.message ?? "not rendered"),
              );
          return disclosure(
            doc,
            "artifact artifact-disclosure",
            `artifact:${ref.artifact_id}`,
            ref.artifact_id,
            h(
              doc,
              "p",
              { class: "artifact-note" },
              `${ref.media_type} · ${ref.byte_length} bytes · ${verified ? "verified" : artifact.status}`,
            ),
            content,
          );
        })
      : [
          h(
            doc,
            "p",
            { class: "muted" },
            "No artifacts yet. Files produced by this task will appear here.",
          ),
        ]),
  );
}
