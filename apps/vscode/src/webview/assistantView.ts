import type { AssistantSession, AssistantTurn } from "../assistantMessages";
import { button, h } from "./dom";

export type Chat = {
  sessions: AssistantSession[];
  activeId: string;
  draft: string;
  configured: boolean;
  consent: boolean;
  loading: boolean;
  pending?: string;
  error?: string;
};

type ChatActions = {
  draft: (value: string) => void;
  consent: (value: boolean) => void;
  send: () => void;
  settings: () => void;
  task: (text: string) => void;
};

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
] as const;

function welcome(): HTMLElement {
  return h(
    "div",
    { class: "assistant-welcome" },
    h("div", { class: "orbit-mark" }),
    h("p", { class: "eyebrow" }, "MARS / ASSISTANT"),
    h("h1", {}, "Where should we start?"),
    h(
      "p",
      { class: "welcome-subtitle" },
      "Explore an idea, plan a build, or talk through code.",
    ),
  );
}

function quickStarts(): HTMLElement {
  return h(
    "div",
    { class: "suggestion-grid" },
    ...suggestions.map(([title, prompt], index) => {
      const suggestion = button(title, `suggestion-${index}`, () => {
        const input =
          document.querySelector<HTMLTextAreaElement>(".assistant-input");
        if (input) {
          input.value = prompt;
          input.dispatchEvent(new Event("input"));
          input.focus();
        }
      });
      suggestion.className = "suggestion";
      const number = h("span", { class: "suggestion-number" }, `0${index + 1}`);
      const arrow = h("span", { class: "suggestion-arrow" }, "↗");
      number.setAttribute("aria-hidden", "true");
      arrow.setAttribute("aria-hidden", "true");
      suggestion.replaceChildren(number, document.createTextNode(title), arrow);
      return suggestion;
    }),
  );
}

function turn(
  message: AssistantTurn,
  index: number,
  actions: ChatActions,
): HTMLElement {
  const assistant = message.role === "assistant";
  const avatar = h("span", { class: "message-avatar" }, assistant ? "✳" : "Y");
  avatar.setAttribute("aria-hidden", "true");
  return h(
    "article",
    { class: `assistant-message message-${message.role}` },
    avatar,
    h(
      "div",
      { class: "message-body" },
      h("p", { class: "message-author" }, assistant ? "MARS" : "You"),
      h("pre", { class: "message-content" }, message.content),
      assistant
        ? button(
            "Make a task ↗",
            `handoff-${index}`,
            () => actions.task(message.content),
            { secondary: true },
          )
        : null,
    ),
  );
}

function composer(
  chat: Chat,
  actions: ChatActions,
  empty: boolean,
): HTMLElement {
  const input = h("textarea", {
    class: "assistant-input",
    key: "assistant-input",
    label: "Message MARS",
  });
  input.rows = 3;
  input.maxLength = 8000;
  input.placeholder =
    "Ask a question, explore an idea, or plan your next build…";
  input.value = chat.draft;
  input.readOnly = Boolean(chat.pending);
  const send = button(
    chat.pending ? "Thinking…" : "Send ↗",
    "assistant-send",
    actions.send,
  );
  const consent = h("input", { key: "chat-consent" });
  consent.type = "checkbox";
  consent.checked = chat.consent;
  consent.disabled = Boolean(chat.pending);
  const updateSend = () => {
    send.disabled =
      chat.loading ||
      Boolean(chat.pending) ||
      !chat.configured ||
      !consent.checked ||
      !input.value.trim();
  };
  updateSend();
  input.addEventListener("input", () => {
    actions.draft(input.value);
    updateSend();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!send.disabled) actions.send();
    }
  });
  consent.addEventListener("change", () => {
    actions.consent(consent.checked);
    updateSend();
  });
  return h(
    "div",
    { class: "assistant-compose-wrap" },
    !chat.configured && !chat.loading
      ? h(
          "div",
          { class: "connect-callout" },
          h(
            "div",
            {},
            h("strong", {}, "Connect a model to start chatting"),
            h("p", {}, "Add your OpenRouter key. Chat uses the free route."),
          ),
          button("Connect model ↗", "connect-model", actions.settings, {
            secondary: true,
          }),
        )
      : null,
    chat.error
      ? h("p", { class: "chat-error", role: "alert" }, chat.error)
      : null,
    h(
      "div",
      { class: "assistant-composer" },
      input,
      h(
        "div",
        { class: "assistant-composer-tools" },
        h("span", { class: "composer-mode" }, "✧ Chat"),
        h("span", { class: "composer-model" }, "OpenRouter · Free"),
        send,
      ),
    ),
    h(
      "label",
      { class: "chat-consent" },
      consent,
      "Share this chat with OpenRouter",
    ),
    empty ? quickStarts() : null,
  );
}

export function renderChat(chat: Chat, actions: ChatActions): HTMLElement {
  const session = chat.sessions.find(({ id }) => id === chat.activeId);
  const messages = [
    ...(session?.messages ?? []),
    ...(chat.pending ? [{ role: "user" as const, content: chat.pending }] : []),
  ];
  const empty = messages.length === 0;
  const transcript = h(
    "section",
    { class: "assistant-scroll", role: "log", label: "Assistant conversation" },
    ...(empty
      ? [welcome()]
      : messages.map((message, index) => turn(message, index, actions))),
    chat.pending
      ? h("p", { class: "thinking", role: "status" }, "✧ MARS is thinking…")
      : null,
  );
  return h(
    "section",
    { class: `assistant-main${empty ? " is-empty" : ""}` },
    transcript,
    composer(chat, actions, empty),
  );
}
