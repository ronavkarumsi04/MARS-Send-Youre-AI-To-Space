import { expect, test } from "bun:test";
import { relativePathProblem } from "../../../contracts/src/path-policy";
import { validatePatchPath } from "./apply";

const CORPUS = [
  "src/app.ts",
  "docs/héllo wörld.md",
  "",
  "/etc/passwd",
  "\\a",
  "a\\b",
  "C:/x",
  "c:x",
  "a//b",
  "a/",
  "./a",
  "a/./b",
  "../a",
  "a/../b",
  "..a/b..",
  "a\u0000b",
  "a\tb",
  "a\u001fb",
  "a\u007fb",
  "a\u0080b",
  "a\u0085b",
  "a\u009fb",
  "a\u00a0b",
  "a\u2028b",
  "a\u2029b",
  "emoji-\u{1f680}",
];

test.each(CORPUS)(
  "validatePatchPath agrees with the shared rule for %j",
  (path) => {
    expect(validatePatchPath(path) === null).toBe(
      relativePathProblem(path) === null,
    );
  },
);
