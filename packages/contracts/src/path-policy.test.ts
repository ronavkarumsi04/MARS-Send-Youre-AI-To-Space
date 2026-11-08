import { describe, expect, test } from "bun:test";
import {
  hasUnsupportedPathCharacters,
  isRelativeRepoPath,
  isSecretPath,
  relativePathProblem,
} from "./path-policy";

describe("relativePathProblem", () => {
  test.each([
    ["", "empty"],
    ["/etc/passwd", "absolute"],
    ["\\a", "backslash"],
    ["a\\b", "backslash"],
    ["C:/windows", "drive"],
    ["c:x", "drive"],
    ["a\u0000b", "control_character"],
    ["a\u001fb", "control_character"],
    ["a\u007fb", "control_character"],
    ["a\u0085b", "control_character"],
    ["a\u2028b", "control_character"],
    ["a\u2029b", "control_character"],
    ["a//b", "empty_segment"],
    ["a/", "empty_segment"],
    ["./a", "dot_segment"],
    ["a/./b", "dot_segment"],
    ["../a", "parent_segment"],
    ["a/../b", "parent_segment"],
  ])("rejects %j as %s", (path, problem) => {
    expect(relativePathProblem(path)).toBe(problem as never);
    expect(isRelativeRepoPath(path)).toBe(false);
  });

  test.each([
    "README",
    "src/app.ts",
    ".github/workflows/ci.yml",
    "docs/héllo wörld.md",
    "a\u00a0b",
    "..a/b..",
  ])("accepts %j", (path) => {
    expect(relativePathProblem(path)).toBeNull();
    expect(isRelativeRepoPath(path)).toBe(true);
  });

  test("rejects non-string input", () => {
    expect(relativePathProblem(undefined as unknown as string)).toBe("empty");
  });
});

test("hasUnsupportedPathCharacters rejects controls, not printable Unicode", () => {
  expect(hasUnsupportedPathCharacters("a\tb")).toBe(true);
  expect(hasUnsupportedPathCharacters("a\u00a0b")).toBe(false);
  expect(hasUnsupportedPathCharacters("emoji-\u{1f680}")).toBe(false);
});

describe("isSecretPath", () => {
  test.each([
    ".env",
    ".ENV",
    ".env.local",
    "config/.env.production",
    ".env.d/value",
    ".npmrc",
    "pkg/.NETRC",
    ".git-credentials",
    "ID_RSA",
    "keys/id_ed25519.pub",
    "certs/server.pem",
    "certs/server.KEY",
    "store.jks",
    "secrets.p12/readme.md",
    ".ssh/config",
    "home/.AWS/credentials",
    ".kube/config",
    ".config/gcloud/credentials.db",
    ".env.example/inner.txt",
  ])("%j is secret", (path) => {
    expect(isSecretPath(path)).toBe(true);
  });

  test.each([
    ".env.example",
    ".ENV.SAMPLE",
    "config/.env.template",
    "src/env.ts",
    "README.md",
    ".config/other/x",
    "gcloud/.config",
    "keys.md",
    "docs/ssh.md",
  ])("%j is not secret", (path) => {
    expect(isSecretPath(path)).toBe(false);
  });
});
