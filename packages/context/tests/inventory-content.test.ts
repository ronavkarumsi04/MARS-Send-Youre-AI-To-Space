import { expect, test } from "bun:test";
import { PYTHON_EXTRACTOR_VERSION } from "../src/extract-python";
import { TS_EXTRACTOR_VERSION } from "../src/extract-ts";
import {
  BINARY_SNIFF_BYTES,
  classifyFileContent,
  type FileContentClassification,
  GENERATED_MARKER_WINDOW,
  MAX_AVERAGE_LINE_LENGTH,
  MAX_GENERATED_LINE_LENGTH,
  selectExtractor,
} from "../src/inventory";

const bytes = (text: string) => Buffer.from(text, "utf8");

test("classifyFileContent returns decoded source text", () => {
  expect(classifyFileContent(bytes("export const a = 1;\n"))).toEqual({
    kind: "source",
    text: "export const a = 1;\n",
  });
  expect(classifyFileContent(bytes(""))).toEqual({ kind: "source", text: "" });
});

test("classifyFileContent flags NUL bytes only inside the sniff window", () => {
  expect(classifyFileContent(bytes("a\0b"))).toEqual({
    kind: "skipped",
    reason: "binary",
  });
  const lateNul = `${"a\n".repeat(BINARY_SNIFF_BYTES / 2)}\0`;
  expect(classifyFileContent(bytes(lateNul)).kind).toBe("source");
});

test("classifyFileContent flags invalid UTF-8 as binary", () => {
  expect(classifyFileContent(Buffer.from([0xc3, 0x28]))).toEqual({
    kind: "skipped",
    reason: "binary",
  });
});

test("classifyFileContent applies the generated-content heuristics", () => {
  const generated: FileContentClassification = {
    kind: "skipped",
    reason: "generated",
  };
  expect(classifyFileContent(bytes("// @generated\nx\n"))).toEqual(generated);
  expect(classifyFileContent(bytes("// DO NOT EDIT\nx\n"))).toEqual(generated);
  const lateMarker = `${"a\n".repeat(GENERATED_MARKER_WINDOW)}// @generated\n`;
  expect(classifyFileContent(bytes(lateMarker)).kind).toBe("source");
  expect(
    classifyFileContent(
      bytes(`${"x".repeat(MAX_GENERATED_LINE_LENGTH + 1)}\n`),
    ),
  ).toEqual(generated);
  const wideLine = "x".repeat(MAX_AVERAGE_LINE_LENGTH + 10);
  expect(classifyFileContent(bytes(`${wideLine}\n${wideLine}`))).toEqual(
    generated,
  );
});

test("classifyFileContent flags private keys as secrets after generated checks", () => {
  const key =
    "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n";
  expect(classifyFileContent(bytes(key))).toEqual({
    kind: "skipped",
    reason: "secret",
  });
  expect(classifyFileContent(bytes(`// @generated\n${key}`))).toEqual({
    kind: "skipped",
    reason: "generated",
  });
});

test("selectExtractor pairs each language with its extractor version", () => {
  const python = selectExtractor("pkg/Module.PY");
  expect(python.version).toBe(PYTHON_EXTRACTOR_VERSION);
  expect(
    python.extract("pkg/Module.PY", "def run():\n  pass\n", 10).defs,
  ).toEqual(expect.arrayContaining([expect.objectContaining({ name: "run" })]));
  const typescript = selectExtractor("src/index.ts");
  expect(typescript.version).toBe(TS_EXTRACTOR_VERSION);
  expect(
    typescript.extract("src/index.ts", "export function run() {}\n", 10).defs,
  ).toEqual(expect.arrayContaining([expect.objectContaining({ name: "run" })]));
});
