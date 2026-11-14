import { expect, test } from "bun:test";
import {
  MAX_READ_BYTES,
  ReadRequestSchema,
  renderRead,
  structuralOutline,
} from "./read-summary";

const bytes = (text: string) => new TextEncoder().encode(text);

test("small reads are unchanged through the threshold and large reads outline", () => {
  for (const size of [24 * 1024 - 1, 24 * 1024]) {
    const text = `${"x".repeat(size - 2)}\r\n`;
    expect(renderRead("a.txt", bytes(text))).toBe(text);
  }
  const large = "x".repeat(24 * 1024 + 1);
  expect(renderRead("a.txt", bytes(large))).toContain("1 lines, 24577 bytes");
  expect(renderRead("a.txt", bytes(large))).toContain(
    "Call mars_read with path, offset",
  );
  expect(renderRead("a.txt", bytes(large))).toContain("line truncated");
  expect(
    renderRead(
      "a.txt",
      bytes("abcdef"),
      {},
      { thresholdBytes: 5, headLines: 0 },
    ),
  ).toContain("5-byte summary threshold");
  expect(renderRead("a.txt", bytes("abcdef"), {}, { thresholdBytes: 6 })).toBe(
    "abcdef",
  );
  expect(() =>
    renderRead("a", bytes("a"), {}, { thresholdBytes: 0 }),
  ).toThrow();
});

test("ranges are inclusive, preserve newlines and enforce bounds and UTF-8 byte cap", () => {
  const content = bytes("one\r\ntwo\r\nthree");
  expect(renderRead("a.txt", content, { start_line: 2, end_line: 2 })).toBe(
    "two\r\n",
  );
  expect(renderRead("a.txt", content, { start_line: 2 })).toBe("two\r\nthree");
  expect(renderRead("a.txt", content, { end_line: 1 })).toBe("one\r\n");
  expect(renderRead("empty", bytes(""))).toBe("");
  expect(renderRead("empty", bytes(""), { start_line: 1, end_line: 1 })).toBe(
    "",
  );
  for (const range of [
    { start_line: 0 },
    { end_line: -1 },
    { start_line: 1.5 },
    { start_line: 3, end_line: 2 },
    { start_line: 4 },
    { end_line: 4 },
  ])
    expect(() => renderRead("a.txt", content, range)).toThrow();
  expect(() => ReadRequestSchema.parse({ path: "a", extra: true })).toThrow();
  const huge = bytes("😀".repeat(MAX_READ_BYTES / 2));
  expect(renderRead("huge.txt", huge)).toContain("Heuristic outline");
  expect(() => renderRead("huge.txt", huge, { start_line: 1 })).toThrow(
    "output limit",
  );
  expect(() => renderRead("binary", new Uint8Array([255]))).toThrow();
});

test("language outlines detect declarations and bound sibling and nested ranges", () => {
  const cases = [
    [
      "a.ts",
      "export interface Shape {\n  x: number;\n}\nexport type ID = string;\nexport const run = () => {\n return 1;\n};\nclass Thing {\n method() {\n  return 2;\n }\n}\nfunction plain() {}\n",
      [
        "interface Shape",
        "type ID",
        "const run",
        "class Thing",
        "method()",
        "function plain",
      ],
    ],
    [
      "a.js",
      "export function run() {\n return 1;\n}\nconst arrow = async () => 1;\n",
      ["function run", "const arrow"],
    ],
    [
      "a.py",
      "class Thing:\n    def run(self):\n        return 1\n\ndef other():\n    return 2\n",
      ["class Thing", "def run", "def other"],
    ],
    [
      "a.go",
      "type Thing struct {\n X int\n}\nfunc (t Thing) Run() {\n}\n",
      ["type Thing", "func (t Thing)"],
    ],
    [
      "a.rs",
      "pub struct Thing {\n x: i32,\n}\nimpl Thing {\n fn run() {}\n}\nenum Kind {}\ntrait Run {}\n",
      ["struct Thing", "impl Thing", "fn run", "enum Kind", "trait Run"],
    ],
    [
      "a.md",
      "# Top\nintro\n## Child\ntext\n```ts\n# Not a heading\n```\n# Next\n",
      ["# Top", "## Child", "# Next"],
    ],
    [
      "a.txt",
      "first block\nmore\n\nsecond block\n",
      ["first block", "second block"],
    ],
  ] as const;
  for (const [path, text, labels] of cases) {
    const outline = structuralOutline(path, text);
    expect(outline.symbols).toHaveLength(labels.length);
    labels.forEach((label, index) => {
      expect(outline.symbols[index]?.label).toContain(label);
    });
    for (const symbol of outline.symbols)
      expect(symbol.endLine).toBeGreaterThanOrEqual(symbol.startLine);
  }
  expect(
    structuralOutline(
      "a.ts",
      "function a() {\n return 1;\n}\nfunction b() {}\n",
    ).symbols[0],
  ).toMatchObject({ startLine: 1, endLine: 3 });
  expect(
    structuralOutline("a.md", "# Top\n## Child\ntext\n# Next\n").symbols[0],
  ).toMatchObject({ startLine: 1, endLine: 3 });
  expect(structuralOutline("a.txt", "").symbols).toEqual([]);
  expect(
    structuralOutline("a.ts", "function a() {}\nfunction b() {}\n", 1)
      .truncated,
  ).toBe(true);
  const output = renderRead(
    "a.ts",
    bytes("export function longName() {}\n".repeat(10000)),
  );
  expect(Buffer.byteLength(output)).toBeLessThan(MAX_READ_BYTES);
  expect(output).toContain("outline symbol limit");
});
