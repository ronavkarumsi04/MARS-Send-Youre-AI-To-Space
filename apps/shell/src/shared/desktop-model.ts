export const DESKTOP_MODEL_CHANNEL = "mars-shell:desktop-model";

export type ModelSettingsResult =
  | "refused"
  | "invalid"
  | "unavailable"
  | "cleared"
  | "saved"
  | "session";

export type DesktopModelSettings = {
  setKey(key: string | null): Promise<ModelSettingsResult>;
  openKeyPage(): Promise<void>;
};
