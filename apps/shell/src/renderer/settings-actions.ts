import type {
  DesktopModelSettings,
  ModelSettingsResult,
} from "../shared/desktop-model";

const messages: Record<ModelSettingsResult, string> = {
  saved: "Key saved in your system’s secure storage.",
  session:
    "Secure storage is unavailable. The key will be used only until MARS quits.",
  cleared: "Saved key cleared.",
  invalid: "Check your key: it must start with sk-or-v1-.",
  refused: "Model settings are unavailable.",
  unavailable: "Could not update the key.",
};

export function settingsActions(
  settings: DesktopModelSettings,
  controls: {
    input: Pick<HTMLInputElement, "value" | "disabled" | "focus">;
    save: Pick<HTMLButtonElement, "disabled">;
    clear: Pick<HTMLButtonElement, "disabled">;
    status: Pick<Element, "textContent">;
  },
) {
  const { input, save, clear, status } = controls;
  return {
    async openKeyPage() {
      if (!(await settings.openKeyPage().catch(() => false)))
        status.textContent =
          "Could not open your browser. Sign in to OpenRouter and go to Settings → API Keys.";
    },
    async apply(key: string | null) {
      status.textContent = "Updating model settings…";
      input.disabled = save.disabled = clear.disabled = true;
      const result = await settings
        .setKey(key)
        .catch(() => "unavailable" as const);
      if (result === "saved" || result === "session" || result === "cleared")
        input.value = "";
      input.disabled = save.disabled = clear.disabled = false;
      if (result === "invalid") input.focus();
      status.textContent = messages[result];
    },
  };
}
