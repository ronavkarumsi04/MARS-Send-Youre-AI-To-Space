import { secretShapeRegexes } from "@mars/contracts";

/**
 * Small secret scrubber for text that leaves the host (worker start payloads,
 * scoring feedback forwarded to the reflection model), using the shared
 * `SECRET_SHAPE_PATTERNS` without research-worker's encoded-needle machinery.
 */
const SECRET_PATTERNS = secretShapeRegexes("g");

export function scrubSecrets(text: string): string {
  let output = text;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, "[redacted]");
  }
  return output;
}

export const TRUNCATION_MARKER = "…[truncated]";

export function bounded(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - TRUNCATION_MARKER.length))}${TRUNCATION_MARKER}`;
}
