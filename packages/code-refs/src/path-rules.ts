/**
 * Locator path and text rules. The path rules are copied (not imported) from
 * `apps/vscode/src/pathSafety.ts` (`checkRelativePath`) so this package
 * depends only on `@mars/contracts` and `zod`; `sync.test.ts` fails when they
 * drift. The invisible-code-point denylist comes from `@mars/contracts`.
 */

import { hasInvisibleCodePoint } from "@mars/contracts";

export {
  hasInvisibleCodePoint,
  INVISIBLE_CODE_POINT_RANGES,
  isInvisibleCodePoint,
} from "@mars/contracts";

export const MAX_PATH_LENGTH = 1024;

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WINDOWS_RESERVED = /[<>:"|?*]/;

export type PathRejectReason =
  | "path_empty_or_too_long"
  | "path_control_characters"
  | "path_backslash"
  | "path_scheme_or_drive"
  | "path_not_relative"
  | "path_bad_segment"
  | "path_reserved_characters"
  | "path_git_segment"
  | "path_invisible_code_point";

export type PathCheck =
  | { ok: true; path: string; segments: string[] }
  | { ok: false; reason: PathRejectReason };

/**
 * Validates a repository-relative POSIX path with exactly the rules of
 * `checkRelativePath` in `apps/vscode/src/pathSafety.ts`. The caller is
 * is expected to have checked the NFC form too (`validateLocatorPath`).
 */
export function checkLocatorPath(path: string): PathCheck {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH)
    return { ok: false, reason: "path_empty_or_too_long" };
  if (
    Array.from(path).some(
      (char) => char.charCodeAt(0) < 0x20 || char === "\u007f",
    )
  )
    return { ok: false, reason: "path_control_characters" };
  if (path.includes("\\")) return { ok: false, reason: "path_backslash" };
  if (SCHEME.test(path)) return { ok: false, reason: "path_scheme_or_drive" };
  if (path.startsWith("/") || path.startsWith("~"))
    return { ok: false, reason: "path_not_relative" };
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..")
      return { ok: false, reason: "path_bad_segment" };
    if (WINDOWS_RESERVED.test(segment))
      return { ok: false, reason: "path_reserved_characters" };
    if (segment.toLowerCase() === ".git")
      return { ok: false, reason: "path_git_segment" };
  }
  if (hasInvisibleCodePoint(path))
    return { ok: false, reason: "path_invisible_code_point" };
  return { ok: true, path, segments };
}

/**
 * Git stores paths as bytes and never normalises Unicode, so the committed
 * spelling is kept verbatim for lookup; the NFC form is checked as well so
 * that normalisation cannot hide a rejected segment.
 */
export function validateLocatorPath(path: string): PathCheck {
  const raw = checkLocatorPath(path);
  if (!raw.ok) return raw;
  const nfc = checkLocatorPath(path.normalize("NFC"));
  if (!nfc.ok) return nfc;
  return raw;
}
