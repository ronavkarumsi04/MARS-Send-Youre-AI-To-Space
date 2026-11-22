import { button, h } from "./dom";

export function toolbar(title: string, tag: string): HTMLElement {
  return h(
    "header",
    { class: "workspace-toolbar" },
    h(
      "div",
      { class: "breadcrumb" },
      "Workspace",
      h("span", {}, "/"),
      h("strong", {}, title),
    ),
    h("span", { class: "mode-badge" }, tag),
  );
}

export function modelNavigation(
  configured: boolean,
  loading: boolean,
  openSettings: () => void,
): HTMLButtonElement {
  return button(
    loading
      ? "Checking model…"
      : configured
        ? "Model connected"
        : "Connect model",
    "nav-model",
    openSettings,
    {
      secondary: loading || configured,
      disabled: loading,
      title: configured
        ? "Manage the saved OpenRouter key"
        : "Open model settings",
    },
  );
}

export function renderSettings(
  configured: boolean,
  loading: boolean,
  error: string | undefined,
  actions: {
    getKey: () => void;
    setKey: () => void;
    removeKey: () => void;
    settings: () => void;
    importConnection: () => void;
    extensions: () => void;
  },
  connection?: HTMLElement,
): HTMLElement {
  return h(
    "section",
    {
      class: "model-settings workspace-content",
      label: "Settings",
    },
    h("h1", {}, "Settings"),
    h(
      "p",
      { class: "welcome-subtitle" },
      "Manage your model, privacy, and project extensions.",
    ),
    h(
      "section",
      { class: "key-help" },
      h("h2", {}, "Model connection"),
      h(
        "p",
        {},
        "Chat uses OpenRouter’s free route. Create an OpenRouter API key, then paste it into the secure VS Code prompt, not into chat.",
      ),
      h(
        "div",
        { class: "row" },
        button(
          configured ? "Replace API key" : "Add OpenRouter API key",
          "set-model-key",
          actions.setKey,
          { disabled: loading },
        ),
        configured
          ? button("Remove key", "remove-model-key", actions.removeKey, {
              secondary: true,
              disabled: loading,
            })
          : null,
        button("Get an OpenRouter API key ↗", "get-model-key", actions.getKey, {
          secondary: true,
        }),
      ),
      h(
        "p",
        { class: "key-status", role: "status" },
        loading
          ? "Checking key status…"
          : configured
            ? "Key saved · OpenRouter Free"
            : "No API key configured",
      ),
      error ? h("p", { class: "chat-error", role: "alert" }, error) : null,
    ),
    h(
      "section",
      { class: "key-help" },
      h("h2", {}, "Privacy"),
      h(
        "p",
        {},
        "After you opt in, sending a chat shares the conversation with OpenRouter, not your project files. Completed conversations are saved in VS Code for this workspace. Your API key is kept in VS Code Secret Storage and is never included in prompts.",
      ),
    ),
    h(
      "section",
      { class: "key-help" },
      h("h2", {}, "Project extensions"),
      h(
        "p",
        {},
        "MCP servers, skills, and plugins can add capabilities to new agent tasks. They do not give Chat access to your files or tools.",
      ),
      button("Browse extensions", "settings-extensions", actions.extensions, {
        secondary: true,
      }),
    ),
    h(
      "section",
      { class: "key-help" },
      h("p", { class: "eyebrow" }, "AGENT / WORKBENCH"),
      h("h2", {}, "Task server"),
      h(
        "p",
        {},
        "Agent tasks run on the connected MARS workbench. They use its own credentials and model policy, separate from your Chat key.",
      ),
      connection,
      h(
        "div",
        { class: "row" },
        button(
          "Import local connection",
          "import-connection",
          actions.importConnection,
          { secondary: true },
        ),
        button(
          "Open MARS preferences ↗",
          "open-preferences",
          actions.settings,
          { secondary: true },
        ),
      ),
    ),
  );
}

const categories = [
  [
    "⌘",
    "MCP servers",
    "Connect tools and data",
    "MCP connects MARS to external tools, like a repository service or database.",
    "Host review required",
    "MARS checks a server’s identity and permissions before allowing access. A familiar name alone is not verification.",
  ],
  [
    "✧",
    "Skills",
    "Teach a repeatable workflow",
    "A skill gives MARS instructions for specific work, such as writing tests or following team conventions.",
    "Project conventions supported",
    "MARS discovers SKILL.md files in your project’s skills, .claude/skills, .codex/skills, and .agents/skills folders.",
  ],
  [
    "◇",
    "Plugins",
    "Bundle capabilities together",
    "A plugin can include skills, tools, and configuration. It can include an MCP server, but it isn’t one by itself.",
    "Review before adding",
    "Check the contents and permissions of a bundle before adding it to your project.",
  ],
] as const;

export function renderExtensions(openSkills: () => void): HTMLElement {
  return h(
    "section",
    { class: "extensions-content workspace-content", label: "Extensions" },
    h("p", { class: "eyebrow" }, "MAKE MARS YOURS"),
    h("h1", {}, "More capable. Still in your control."),
    h(
      "p",
      { class: "welcome-subtitle" },
      "Tools and skills are for new agent tasks in this project. Extensions don’t give Assistant chat access to your files or tools.",
    ),
    h(
      "section",
      { class: "extension-library", label: "Verified extension library" },
      h("h2", {}, "Verified library"),
      h(
        "p",
        {},
        "Verified installs are available in managed MARS Desktop projects. This VS Code extension connects to an existing workbench, which does not expose the installer.",
      ),
    ),
    ...categories.map(([icon, title, subtitle, body, status, detail]) => {
      const marker = h("span", { class: "extension-icon" }, icon);
      marker.setAttribute("aria-hidden", "true");
      return h(
        "article",
        { class: "extension-category" },
        marker,
        h(
          "div",
          {},
          h("h2", {}, title),
          h("p", { class: "extension-subtitle" }, subtitle),
          h("p", {}, body),
          h("span", { class: "extension-state" }, status),
          h("p", {}, detail),
          title === "Skills"
            ? button(
                "Open Skills dashboard ↗",
                "extensions-skills",
                openSkills,
                { secondary: true },
              )
            : null,
        ),
      );
    }),
    h(
      "p",
      { class: "extensions-note" },
      "Model keys belong in Settings. A tool’s credentials are separate; never paste secrets into a chat or skill.",
    ),
  );
}
