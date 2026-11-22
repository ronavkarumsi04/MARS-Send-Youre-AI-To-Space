export const CLIPBOARD_CHANNEL = "mars-shell:clipboard-write";
export const MAX_COPY_LENGTH = 1_000_000;

/** Plain-text writes only. No clipboard reads or generic native access. */
export type ClipboardApi = {
  writeText(text: string): Promise<{ ok: boolean }>;
};
