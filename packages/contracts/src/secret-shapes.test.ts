import { describe, expect, test } from "bun:test";
import {
  containsSecretToken,
  SECRET_CONTEXT_PATTERNS,
  SECRET_SHAPE_PATTERNS,
  SECRET_TOKEN_PATTERNS,
  secretShapeRegexes,
} from "./index";

const CONTEXT_SAMPLES = [
  "Authorization: Bearer abcdefghijklmnop",
  "api_key=supersecretvalue99",
  "password: hunter2hunter2",
];

const TOKEN_SAMPLES = [
  "sk-abcdefghijklmnop",
  "pk-abcdefghijklmnop",
  "rk-abcdefghijklmnop",
  "AKIAABCDEFGHIJKLMNOP",
  "ghp_abcdefghijklmnopqrst",
  "gho_abcdefghijklmnopqrst",
  "ghs_abcdefghijklmnopqrst",
  "github_pat_abcdefghijklmnopqrst",
  "-----BEGIN RSA PRIVATE KEY-----",
  "xoxb-1234567890",
  "env_sk-abcdefghijklmnop",
  "MY_ghp_abcdefghijklmnopqrst",
];

describe("secret shapes", () => {
  test("every known token shape is detected", () => {
    for (const sample of TOKEN_SAMPLES) {
      expect(containsSecretToken(`see ${sample} here`)).toBe(true);
    }
  });

  test("credential-context shapes are scrubbed but do not fail publishing", () => {
    for (const sample of [
      ...CONTEXT_SAMPLES,
      "Requires Bearer authentication",
    ]) {
      expect(containsSecretToken(sample)).toBe(false);
      expect(secretShapeRegexes().some((pattern) => pattern.test(sample))).toBe(
        true,
      );
    }
  });

  test("ordinary text is not a secret", () => {
    for (const text of [
      "task-abcdefghijklmnopqrst",
      "the token budget is fine",
      "ghp_short",
      "sk-short",
    ]) {
      expect(containsSecretToken(text)).toBe(false);
    }
  });

  test("shared patterns are non-global; derived regexes add flags", () => {
    expect(SECRET_SHAPE_PATTERNS.every((p) => !p.global)).toBe(true);
    const global = secretShapeRegexes("g");
    expect(global.map((p) => p.source)).toEqual(
      SECRET_SHAPE_PATTERNS.map((p) => p.source),
    );
    expect(global.every((p) => p.global)).toBe(true);
    expect(global[0]?.flags).toBe("gi");
    expect(SECRET_SHAPE_PATTERNS).toEqual([
      ...SECRET_CONTEXT_PATTERNS,
      ...SECRET_TOKEN_PATTERNS,
    ]);
  });

  test("a PEM block is matched through its END line", () => {
    const pem =
      "-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBg\n-----END PRIVATE KEY-----";
    let output = `x ${pem} y`;
    for (const pattern of secretShapeRegexes("g")) {
      output = output.replace(pattern, "[redacted]");
    }
    expect(output).toBe("x [redacted] y");
  });
});
