import { describe, expect, test } from "bun:test";
import type { EditResult } from "./anchored-edit";
import {
  anchorOf,
  applyEdits,
  applyReplace,
  editOpSchema,
  editOpsSchema,
  formatAnchored,
  HASH_ALPHABET,
  lineHash,
  parseText,
  serializeText,
} from "./anchored-edit";

function success(result: EditResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result;
}

function failure(result: EditResult, kind: "stale" | "ambiguous" | "invalid") {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected failure");
  expect(result.error.kind).toBe(kind);
  expect(result).not.toHaveProperty("text");
  return result.error;
}

describe("line model and anchors", () => {
  test.each([
    "",
    "\uFEFF",
    "\n",
    "\r\n",
    "a\n\n",
    "a\r\nb\r\n",
    "a\r\nb",
    "a",
    "\uFEFFa\r\nb\r\n",
    "😀e\u0301中文\n終",
    "\uFEFF😀\n",
  ])("round trips %j", (text) => {
    expect(serializeText(parseText(text))).toBe(text);
  });

  test("models empty and trailing lines and normalizes mixed endings", () => {
    expect(parseText("")).toEqual({
      lines: [],
      eol: "\n",
      bom: false,
      trailingNewline: false,
    });
    expect(parseText("a\n").lines).toEqual(["a"]);
    expect(serializeText(parseText("a\r\nb\nc"))).toBe("a\r\nb\r\nc");
    expect(serializeText(parseText("a\nb\r\nc"))).toBe("a\nb\nc");
  });

  test("stable 15-bit xxHash tags with an unambiguous 32-character alphabet", () => {
    expect(new Set(HASH_ALPHABET).size).toBe(32);
    expect(HASH_ALPHABET).toBe("abcdefghijkmnpqrstuvwxyz23456789");
    expect(HASH_ALPHABET).not.toMatch(/[0o1l_]/);
    for (const text of ["", "hello", " hello", "hello ", "😀e\u0301中文"]) {
      const expected = Bun.hash.xxHash32(text);
      expect(lineHash(text)).toBe(
        [0, 5, 10]
          .map((shift) => HASH_ALPHABET[(expected >>> shift) & 31])
          .join(""),
      );
      expect(lineHash(text)).toBe(lineHash(text));
      expect(lineHash(text)).toHaveLength(3);
      expect(
        [...lineHash(text)].every((char) => HASH_ALPHABET.includes(char)),
      ).toBe(true);
    }
    expect(lineHash("hello")).not.toBe(lineHash("hello "));
    expect(anchorOf(1, "hello").split(":")[1]).toBe(
      anchorOf(99, "hello").split(":")[1],
    );
  });

  test("formats inclusive one-based rows", () => {
    expect(formatAnchored(["a", "b", "c"], 2, 3)).toBe(
      `${anchorOf(2, "b")}|b\n${anchorOf(3, "c")}|c`,
    );
    expect(formatAnchored([], 1, 0)).toBe("");
  });
});

describe("anchored edits", () => {
  const original = "a\nb\nc\nd\n";
  const a = anchorOf(1, "a");
  const b = anchorOf(2, "b");
  const c = anchorOf(3, "c");
  const d = anchorOf(4, "d");

  test("replace a line or inclusive range and delete a line or range", () => {
    expect(
      success(
        applyEdits(original, [{ op: "replace", anchor: b, content: "B" }]),
      ).text,
    ).toBe("a\nB\nc\nd\n");
    expect(
      success(
        applyEdits(original, [
          { op: "replace", anchor: b, end: c, content: "B\nC\nX\n" },
        ]),
      ).text,
    ).toBe("a\nB\nC\nX\nd\n");
    expect(
      success(applyEdits(original, [{ op: "delete", anchor: b }])).text,
    ).toBe("a\nc\nd\n");
    expect(
      success(applyEdits(original, [{ op: "delete", anchor: b, end: c }])).text,
    ).toBe("a\nd\n");
    expect(
      success(applyEdits(original, [{ op: "delete", anchor: a, end: d }])).text,
    ).toBe("");
  });

  test("insert before and after lines", () => {
    expect(
      success(
        applyEdits(original, [
          { op: "insert_before", anchor: b, content: "x" },
        ]),
      ).text,
    ).toBe("a\nx\nb\nc\nd\n");
    expect(
      success(
        applyEdits(original, [{ op: "insert_after", anchor: b, content: "x" }]),
      ).text,
    ).toBe("a\nb\nx\nc\nd\n");
  });

  test("summary includes exactly one context line around a replacement", () => {
    const result = success(
      applyEdits("a\nb\nc\nd\ne", [{ op: "replace", anchor: c, content: "C" }]),
    );
    expect(result.summary.split("\n").slice(1)).toEqual([
      `${b}|b`,
      `${anchorOf(3, "C")}|C`,
      `${d}|d`,
    ]);
  });

  test.each(["insert_before", "insert_after"])(
    "%s BOF and EOF, including empty files",
    (op) => {
      for (const anchor of ["BOF", "EOF"]) {
        expect(
          success(applyEdits("", [{ op, anchor, content: "x" }])).text,
        ).toBe("x");
        expect(
          success(applyEdits("\uFEFF", [{ op, anchor, content: "x" }])).text,
        ).toBe("\uFEFFx");
        expect(
          success(applyEdits(original, [{ op, anchor, content: "x" }])).text,
        ).toBe(anchor === "BOF" ? `x\n${original}` : `${original}x\n`);
      }
    },
  );

  test("sequential operations resolve original anchors after shifts", () => {
    const result = success(
      applyEdits(original, [
        { op: "insert_before", anchor: a, content: "x\ny" },
        { op: "replace", anchor: c, content: "C" },
        { op: "delete", anchor: b },
        { op: "insert_after", anchor: d, content: "z" },
      ]),
    );
    expect(result.text).toBe("x\ny\na\nC\nd\nz\n");
    expect(result.summary).toContain("Applied 4 edits");
    expect(result.summary).toContain(`${anchorOf(4, "C")}|C`);
  });

  test("reverse order and fresh anchors are supported", () => {
    expect(
      success(
        applyEdits(original, [
          { op: "replace", anchor: d, content: "D" },
          { op: "delete", anchor: c },
          { op: "insert_before", anchor: a, content: "x" },
          { op: "replace", anchor: anchorOf(1, "x"), content: "X" },
        ]),
      ).text,
    ).toBe("X\na\nb\nD\n");
  });

  test("stale lines return fresh original-file anchors and sightings", () => {
    const error = failure(
      applyEdits("changed\na\nc", [{ op: "delete", anchor: a }]),
      "stale",
    );
    expect(error.opIndex).toBe(1);
    expect(error.anchor).toBe(a);
    expect(error.recovery).toContain(`${anchorOf(1, "changed")}|changed`);
    expect(error.recovery).toContain("hash seen at line 2");
    expect(error.message).toContain("nothing written");
    expect(
      failure(applyEdits("", [{ op: "delete", anchor: a }]), "stale").recovery,
    ).toContain('"BOF"');
  });

  test("changed and deleted original lines are stale and third-op failure is atomic", () => {
    const changed = failure(
      applyEdits(original, [
        { op: "replace", anchor: b, content: "B" },
        { op: "delete", anchor: b },
      ]),
      "stale",
    );
    expect(changed.recovery).toContain(`${b}|b`);
    const error = failure(
      applyEdits(original, [
        { op: "insert_before", anchor: a, content: "x" },
        { op: "delete", anchor: b },
        { op: "delete", anchor: b },
      ]),
      "stale",
    );
    expect(error.opIndex).toBe(3);
    expect(error.recovery).toContain(`${a}|a`);
    expect(original).toBe("a\nb\nc\nd\n");
  });

  test("two distinct matching positions are ambiguous, not guessed", () => {
    const error = failure(
      applyEdits("a\na\nb", [
        { op: "insert_before", anchor: a, content: "x" },
        { op: "delete", anchor: anchorOf(2, "a") },
      ]),
      "ambiguous",
    );
    expect(error.opIndex).toBe(2);
    expect(
      success(applyEdits("a\na", [{ op: "delete", anchor: a }])).text,
    ).toBe("a");
  });

  test("pasted rows and whitespace are accepted; prefixes strip only when universal", () => {
    expect(
      success(
        applyEdits(original, [
          {
            op: "replace",
            anchor: `  ${b}|b  `,
            content: `${a}|A\r\n${b}|B\r\n`,
          },
        ]),
      ).text,
    ).toBe("a\nA\nB\nc\nd\n");
    expect(
      success(
        applyEdits(original, [
          { op: "replace", anchor: b, content: `${a}|A\nplain` },
        ]),
      ).text,
    ).toBe(`a\n${a}|A\nplain\nc\nd\n`);
    expect(
      success(applyEdits(original, [{ op: "replace", anchor: b, content: "" }]))
        .text,
    ).toBe("a\n\nc\nd\n");
    expect(
      success(
        applyEdits(original, [{ op: "replace", anchor: b, content: "B\n\n" }]),
      ).text,
    ).toBe("a\nB\n\nc\nd\n");
  });

  test("strict validation rejects bad operations and ranges", () => {
    for (const anchor of [
      "1:abcx",
      "0:abc",
      "1:ooo",
      "1:ABC",
      "-1:abc",
      "9007199254740992:abc",
      "BOF",
    ]) {
      failure(applyEdits(original, [{ op: "delete", anchor }]), "invalid");
    }
    for (const ops of [
      null,
      {},
      [null],
      [{ op: "unknown", anchor: a }],
      [{ op: "replace", anchor: a }],
      [{ op: "delete", anchor: a, extra: true }],
      Array.from({ length: 101 }, () => ({ op: "delete", anchor: a })),
    ]) {
      failure(applyEdits(original, ops), "invalid");
    }
    expect(
      editOpSchema.safeParse({ op: "delete", anchor: a, content: "x" }).success,
    ).toBe(false);
    expect(editOpsSchema.safeParse([]).success).toBe(true);
    expect(success(applyEdits(original, [])).text).toBe(original);
    expect(
      failure(
        applyEdits(original, [{ op: "delete", anchor: c, end: b }]),
        "invalid",
      ).message,
    ).toContain("range end before start");
    failure(
      applyEdits(original, [
        { op: "replace", anchor: a, end: anchorOf(8, "missing"), content: "x" },
      ]),
      "stale",
    );
  });

  test("preserves BOM, CRLF, and missing final newline", () => {
    expect(
      success(
        applyEdits("\uFEFFa\r\nb", [
          { op: "replace", anchor: b, content: "😀\r\n中" },
        ]),
      ).text,
    ).toBe("\uFEFFa\r\n😀\r\n中");
  });

  test("large files and huge rows keep recoveries and summaries bounded", () => {
    const lines = Array.from({ length: 50_000 }, (_, i) => `line ${i + 1}`);
    const text = lines.join("\n");
    const result = success(
      applyEdits(text, [
        { op: "insert_before", anchor: "BOF", content: "new" },
        {
          op: "replace",
          anchor: anchorOf(49_990, "line 49990"),
          content: "changed",
        },
      ]),
    );
    expect(result.text.split("\n")[49_990]).toBe("changed");
    const error = failure(
      applyEdits(text, [{ op: "delete", anchor: anchorOf(25_000, "wrong") }]),
      "stale",
    );
    expect(new TextEncoder().encode(error.recovery).length).toBeLessThanOrEqual(
      8192,
    );
    expect(
      error.recovery.split("\n").filter((row) => /^\d+:/.test(row)).length,
    ).toBeLessThanOrEqual(60);
    const huge = "😀".repeat(5000);
    const hugeError = failure(
      applyEdits(huge, [{ op: "delete", anchor: a }]),
      "stale",
    );
    expect(hugeError.recovery).toContain("…");
    expect(
      new TextEncoder().encode(hugeError.recovery).length,
    ).toBeLessThanOrEqual(8192);
    const many = success(
      applyEdits(text, [
        {
          op: "replace",
          anchor: anchorOf(1, "line 1"),
          end: anchorOf(100, "line 100"),
          content: lines.slice(0, 100).join("\n"),
        },
      ]),
    );
    expect(many.summary).toContain("…");
    expect(
      many.summary.split("\n").filter((row) => /^\d+:/.test(row)).length,
    ).toBeLessThanOrEqual(40);
  });
});

describe("exact replacement", () => {
  test("unique substring and multiline replacement summaries", () => {
    const result = success(
      applyReplace("a\nhello world\nc\n", "hello", "goodbye"),
    );
    expect(result.text).toBe("a\ngoodbye world\nc\n");
    expect(result.summary).toContain("Replaced 1 match(es)");
    expect(result.summary).toContain("2|goodbye world");
    expect(success(applyReplace("a\nb\nc", "a\nb", "x\ny\nz")).text).toBe(
      "x\ny\nz\nc",
    );
  });

  test("zero matches shows trimmed candidate context in plain rows", () => {
    const error = failure(
      applyReplace("a\n  hello\nc", "hello\nmissing", "x"),
      "invalid",
    );
    expect(error.message).toContain("no exact match");
    expect(error.recovery).toContain("2|  hello");
    expect(error.recovery).not.toContain(anchorOf(2, "  hello"));
    expect(failure(applyReplace("a", "absent", "x"), "invalid").recovery).toBe(
      "",
    );
    expect(failure(applyReplace("", "a", "x"), "invalid").recovery).toContain(
      "empty",
    );
    expect(failure(applyReplace("a", "", "x"), "invalid").message).toContain(
      "non-empty",
    );
  });

  test("multiple matches require replace_all and list line numbers", () => {
    const error = failure(applyReplace("a\nb\na", "a", "x"), "invalid");
    expect(error.message).toContain("lines 1, 3");
    expect(error.message).toContain("replace_all");
    expect(error.recovery).toBe("1|a\n2|b\n3|a");
    const result = success(applyReplace("a\nb\na", "a", "x\ny", true));
    expect(result.text).toBe("x\ny\nb\nx\ny");
    expect(result.summary).toContain("Replaced 2 match(es)");
    expect(result.summary).toContain("4|x");
    expect(success(applyReplace("aaaa", "aa", "b", true)).text).toBe("bb");
  });

  test("normalizes matching while preserving CRLF/BOM and final newline changes", () => {
    expect(
      success(applyReplace("\uFEFFa\r\nb\r\nc\r\n", "a\nb", "😀\n中")).text,
    ).toBe("\uFEFF😀\r\n中\r\nc\r\n");
    expect(success(applyReplace("a\r\nb", "a\r\nb", "x\r\ny")).text).toBe(
      "x\r\ny",
    );
    expect(success(applyReplace("a\n", "a\n", "b")).text).toBe("b");
    expect(success(applyReplace("a", "a", "")).text).toBe("");
  });

  test("bounds multiple-match diagnostics and long candidate rows", () => {
    const error = failure(
      applyReplace(Array.from({ length: 100 }, () => "a").join("\n"), "a", "b"),
      "invalid",
    );
    expect(error.message).toContain("1, 2, 3, 4, 5, 6, 7, 8, 9, 10;");
    const huge = "中".repeat(5000);
    const long = failure(
      applyReplace(` ${huge}`, `${huge}\nmissing`, "x"),
      "invalid",
    );
    expect(new TextEncoder().encode(long.recovery).length).toBeLessThanOrEqual(
      8192,
    );
  });
});
