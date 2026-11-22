import type {
  DesktopModelSettings,
  ModelSettingsResult,
} from "../shared/desktop-model";

const settings = (
  globalThis as typeof globalThis & {
    marsModelSettings?: DesktopModelSettings;
  }
).marsModelSettings;
const form = document.querySelector("form");
const input = document.querySelector<HTMLInputElement>("#model-key");
const save = document.querySelector<HTMLButtonElement>("[type=submit]");
const clear = document.querySelector<HTMLButtonElement>("#clear-key");
const status = document.querySelector("#model-status");
const messages: Record<ModelSettingsResult, string> = {
  saved: "Key saved in your system’s secure storage.",
  session:
    "Secure storage is unavailable. The key will be used only until MARS quits.",
  cleared: "Saved key cleared.",
  invalid: "Enter a valid OpenRouter API key.",
  refused: "Model settings are unavailable.",
  unavailable: "Could not update the key.",
};

if (settings && form && input && save && clear && status) {
  const apply = async (key: string | null) => {
    input.value = "";
    status.textContent = "Updating model settings…";
    save.disabled = clear.disabled = true;
    const result = await settings
      .setKey(key)
      .catch(() => "unavailable" as const);
    status.textContent = messages[result];
    save.disabled = clear.disabled = false;
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void apply(input.value.trim());
  });
  clear.addEventListener("click", () => void apply(null));
}
