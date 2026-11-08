/**
 * Shared MARS path policy: the repository-relative path shape and the
 * secret-path rule that decide which files may reach model context. Byte and
 * depth limits stay with each caller; this module has no Node dependencies.
 */

export type RelativePathProblem =
  | "empty"
  | "absolute"
  | "backslash"
  | "drive"
  | "control_character"
  | "empty_segment"
  | "dot_segment"
  | "parent_segment";

const secretNames = new Set([
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  ".htpasswd",
]);
const secretExtensions = new Set([
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".keystore",
  ".jks",
]);
const privateKeyPrefixes = ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"];
const credentialDirectories = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  ".docker",
  ".kube",
  ".azure",
]);
const envExamples = new Set([".env.example", ".env.sample", ".env.template"]);

/** C0 and C1 controls, DEL, and the U+2028/U+2029 line separators. */
export function hasUnsupportedPathCharacters(path: string): boolean {
  for (const character of path) {
    const code = character.codePointAt(0);
    if (
      code !== undefined &&
      (code <= 0x1f ||
        (code >= 0x7f && code <= 0x9f) ||
        code === 0x2028 ||
        code === 0x2029)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Returns why `path` is not a normalized repository-relative POSIX path, or
 * `null` when it is: non-empty, no leading `/`, no `\`, no drive letter, no
 * unsupported characters, and no empty, `.` or `..` segments.
 */
export function relativePathProblem(path: string): RelativePathProblem | null {
  if (typeof path !== "string" || path.length === 0) return "empty";
  if (path.startsWith("/")) return "absolute";
  if (path.includes("\\")) return "backslash";
  if (/^[A-Za-z]:/.test(path)) return "drive";
  if (hasUnsupportedPathCharacters(path)) return "control_character";
  for (const segment of path.split("/")) {
    if (segment.length === 0) return "empty_segment";
    if (segment === ".") return "dot_segment";
    if (segment === "..") return "parent_segment";
  }
  return null;
}

export function isRelativeRepoPath(path: string): boolean {
  return relativePathProblem(path) === null;
}

/**
 * Whether a relative path names a credential or secret file (case-insensitive):
 * credential directories, `.config/gcloud`, secret names, private-key prefixes,
 * key/cert extensions, and `.env*` (example basenames excepted).
 */
export function isSecretPath(path: string): boolean {
  const segments = path.split("/").map((segment) => segment.toLowerCase());
  const basename = segments.at(-1) ?? "";
  return (
    segments.some((segment) => credentialDirectories.has(segment)) ||
    segments.some(
      (segment, index) =>
        segment === ".config" && segments[index + 1] === "gcloud",
    ) ||
    segments.slice(0, -1).some((segment) => isSecretName(segment, false)) ||
    isSecretName(basename, true)
  );
}

function isSecretName(name: string, allowExamples: boolean): boolean {
  if (
    secretNames.has(name) ||
    privateKeyPrefixes.some((prefix) => name.startsWith(prefix))
  ) {
    return true;
  }
  if (name === ".env" || name.startsWith(".env.")) {
    return !(allowExamples && envExamples.has(name));
  }
  return secretExtensions.has(name.slice(name.lastIndexOf(".")));
}
