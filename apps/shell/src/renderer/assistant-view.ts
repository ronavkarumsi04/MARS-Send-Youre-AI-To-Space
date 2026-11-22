import type { AssistantSession } from "../shared/assistant";
import { h, type ShellDocument, type ShellElement } from "./dom";

export type AssistantViewState = {
  sessions: AssistantSession[];
  activeId: string;
  draft: string;
  configured: boolean;
  canConfigure?: boolean;
  consent: boolean;
  busy: boolean;
  loading: boolean;
  error?: string | undefined;
  pending?: { id: string; text: string } | undefined;
  onDraft?: (draft: string) => void;
  onConsent?: (consent: boolean) => void;
  onSend?: () => void;
  onSettings?: () => void;
  onRetryLoad?: () => void;
  onNew?: () => void;
  onSelect?: (id: string) => void;
  onTask?: (text: string) => void;
};

function action(
  doc: ShellDocument,
  text: string,
  className: string,
  fn?: () => void,
): ShellElement {
  const button = h(doc, "button", { type: "button", class: className }, text);
  button.addEventListener("click", () => fn?.());
  return button;
}

export function renderAssistant(
  doc: ShellDocument,
  state: AssistantViewState,
): ShellElement {
  const session = state.sessions.find((item) => item.id === state.activeId);
  const messages = [
    ...(session?.messages ?? []),
    ...(state.pending?.id === state.activeId
      ? [{ role: "user" as const, content: state.pending.text }]
      : []),
  ];
  const empty = messages.length === 0;
  const input = h(doc, "textarea", {
    rows: "3",
    maxlength: "8000",
    class: "assistant-input",
    "aria-label": "Message MARS",
    placeholder: "Ask a question, explore an idea, or plan your next build…",
    "data-focus-key": "assistant-input",
    disabled: state.busy || state.loading,
  });
  input.value = state.draft;
  input.addEventListener("input", () => state.onDraft?.(input.value ?? ""));
  input.addEventListener("keydown", (event) => {
    const key = event as typeof event & {
      key?: string;
      shiftKey?: boolean;
      isComposing?: boolean;
    };
    if (key.key === "Enter" && !key.shiftKey && !key.isComposing) {
      event.preventDefault?.();
      state.onSend?.();
    }
  });
  const send = action(
    doc,
    state.busy ? "Thinking…" : "Send ↗",
    "assistant-send",
    state.onSend,
  );
  send.disabled =
    state.busy || state.loading || !state.configured || !state.consent;
  const consent = h(doc, "input", {
    type: "checkbox",
    "aria-label": "Share this chat with OpenRouter",
    "data-focus-key": "chat-consent",
  });
  consent.checked = state.consent;
  consent.addEventListener("change", () =>
    state.onConsent?.(Boolean(consent.checked)),
  );
  const suggestions = [
    [
      "Explore an idea",
      "Help me think through an idea for a new feature. Ask me a few questions to get started.",
    ],
    [
      "Plan a build",
      "Help me break down a coding project into a clear implementation plan.",
    ],
    [
      "Talk through code",
      "I want to understand some code. What should I share so we can walk through it together?",
    ],
  ];
  const form = h(
    doc,
    "form",
    { class: "assistant-composer" },
    input,
    h(
      doc,
      "div",
      { class: "assistant-composer-tools" },
      h(doc, "span", { class: "composer-mode" }, "✧  Chat"),
      h(
        doc,
        "span",
        { class: "composer-model" },
        "OpenRouter · Free",
        h(doc, "span", { class: "model-dot" }, "●"),
      ),
      send,
    ),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault?.();
    state.onSend?.();
  });
  return h(
    doc,
    "main",
    {
      class: `main assistant-main${empty ? " is-empty" : ""}`,
      "data-panel": "assistant",
    },
    h(
      doc,
      "header",
      { class: "workspace-toolbar" },
      h(
        doc,
        "div",
        { class: "breadcrumb" },
        "Workspace",
        h(doc, "span", {}, "/"),
        h(doc, "strong", {}, session?.title ?? "New conversation"),
      ),
      h(doc, "span", { class: "mode-badge" }, "✧  Chat"),
    ),
    h(
      doc,
      "section",
      {
        class: "assistant-scroll",
        role: "log",
        "aria-label": "Assistant conversation",
        "aria-live": "polite",
      },
      ...(empty
        ? [
            h(
              doc,
              "div",
              { class: "assistant-welcome" },
              h(
                doc,
                "div",
                { class: "orbit-mark", "aria-hidden": "true" },
                "✳",
              ),
              h(
                doc,
                "p",
                { class: "eyebrow" },
                "MISSION CONTROL  /  ASSISTANT",
              ),
              h(
                doc,
                "h1",
                {},
                "What are we",
                h(doc, "span", {}, "working on?"),
              ),
              h(
                doc,
                "p",
                { class: "welcome-subtitle" },
                "Explore an idea here, then hand a plan to your agent.",
              ),
              h(
                doc,
                "div",
                { class: "suggestion-grid" },
                ...suggestions.map(([title, prompt]) =>
                  action(doc, `${title}  ↗`, "suggestion", () => {
                    state.onDraft?.(prompt ?? "");
                  }),
                ),
              ),
            ),
          ]
        : messages.map((message) =>
            h(
              doc,
              "article",
              { class: `assistant-message message-${message.role}` },
              h(
                doc,
                "div",
                { class: "message-avatar", "aria-hidden": "true" },
                message.role === "user" ? "Y" : "✳",
              ),
              h(
                doc,
                "div",
                { class: "message-body" },
                h(
                  doc,
                  "p",
                  { class: "message-author" },
                  message.role === "user" ? "You" : "MARS",
                ),
                h(doc, "pre", { class: "message-content" }, message.content),
                message.role === "assistant"
                  ? action(doc, "Make a task  ↗", "message-handoff", () =>
                      state.onTask?.(message.content),
                    )
                  : null,
              ),
            ),
          )),
      state.busy
        ? h(
            doc,
            "p",
            { class: "thinking", role: "status" },
            "✧  MARS is thinking…",
          )
        : null,
    ),
    h(
      doc,
      "div",
      { class: "assistant-compose-wrap" },
      !state.configured && !state.loading && state.canConfigure !== undefined
        ? h(
            doc,
            "div",
            { class: "connect-notice" },
            h(
              doc,
              "div",
              {},
              h(doc, "strong", {}, "Connect your first model"),
              h(
                doc,
                "p",
                {},
                state.canConfigure
                  ? "Add an OpenRouter API key to bring MARS online."
                  : "Set OPENROUTER_API_KEY in the environment that launches MARS, then restart the attached app.",
              ),
            ),
            state.canConfigure
              ? action(
                  doc,
                  "Connect model  ↗",
                  "connect-action",
                  state.onSettings,
                )
              : null,
          )
        : null,
      state.error
        ? h(
            doc,
            "div",
            { class: "chat-error", role: "alert" },
            state.error,
            state.onRetryLoad
              ? action(doc, "Retry chat", "retry", state.onRetryLoad)
              : null,
          )
        : null,
      form,
      state.configured
        ? h(
            doc,
            "label",
            { class: "chat-cost" },
            consent,
            "Send this conversation to OpenRouter’s free model route",
          )
        : null,
      h(
        doc,
        "p",
        { class: "composer-footnote" },
        state.loading
          ? "Loading your conversations…"
          : "Chat thinks with you. Tasks work in your project.  ·  Enter to send, Shift + Enter for a new line.",
      ),
    ),
  );
}
