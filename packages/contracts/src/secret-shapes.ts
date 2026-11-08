/**
 * The one list of secret shapes every host boundary checks: publishability
 * gates (`specialists`, `collaboration`) test against it and the off-host
 * scrubbers (`research-worker`, `optimization`) redact with it. The Python
 * GEPA worker keeps a literal copy (`mars_gepa_worker/scrub.py`) that a parity
 * test pins to this list. Patterns are non-global so `.test` is stateless;
 * use `secretShapeRegexes("g")` for replacement. Token shapes anchor on a
 * preceding non-alphanumeric so `env_sk-…` is caught but `task-…` is not.
 */
export const SECRET_SHAPE_PATTERNS: readonly RegExp[] = Object.freeze([
  /\b(?:bearer|basic)\s+[a-z0-9._~+/=-]{8,}/i,
  /\b(?:api[_-]?key|access[_-]?token|secret|password|passwd|token)\s*[:=]\s*["']?[^\s"']{6,}/i,
  /(?<![A-Za-z0-9])(?:sk|pk|rk)-[a-z0-9_-]{16,}\b/i,
  /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}\b/,
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}\b/,
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)?/,
  /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}\b/,
]);

/** Fresh copies of the list with `extraFlags` (e.g. "g") added. */
export function secretShapeRegexes(extraFlags = ""): RegExp[] {
  return SECRET_SHAPE_PATTERNS.map(
    (pattern) =>
      new RegExp(
        pattern.source,
        [...new Set(pattern.flags + extraFlags)].join(""),
      ),
  );
}

export function containsSecretShape(text: string): boolean {
  return SECRET_SHAPE_PATTERNS.some((pattern) => pattern.test(text));
}
