/**
 * Prepares untrusted text for model-visible evidence: every run of C0/DEL
 * control characters collapses to one space (so a value can never start a
 * forged `[untrusted ...]` framing line), the result is trimmed, and values
 * longer than `maxChars` are cut with a trailing ellipsis.
 */
export function untrustedText(
  value: string,
  maxChars = Number.POSITIVE_INFINITY,
): string {
  let out = "";
  let lastWasControl = false;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const control = code < 0x20 || code === 0x7f;
    if (control) {
      if (!lastWasControl) out += " ";
    } else out += char;
    lastWasControl = control;
  }
  out = out.trim();
  return out.length > maxChars ? `${out.slice(0, maxChars)}…` : out;
}
