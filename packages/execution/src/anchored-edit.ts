// Inspired by Oh My Pi's hashline idea (can1357/oh-my-pi, MIT) and
// https://blog.can.ac/2026/02/12/the-harness-problem/; no upstream code copied.
// These are per-line tags as in the post, not omp 18.14's per-file tags.
import { z } from "zod";

export interface TextModel {
  lines: string[];
  eol: "\n" | "\r\n";
  bom: boolean;
  trailingNewline: boolean;
}

/** Mixed line endings are normalized to the first line break on serialization. */
export function parseText(text: string): TextModel {
  const bom = text.startsWith("\uFEFF");
  const body = bom ? text.slice(1) : text;
  const eol = /\r?\n/.exec(body)?.[0] === "\r\n" ? "\r\n" : "\n";
  const trailingNewline = body.endsWith("\n");
  const lines = body === "" ? [] : body.split(/\r?\n/);
  if (trailingNewline) lines.pop();
  return { lines, eol, bom, trailingNewline };
}

export function serializeText(model: TextModel): string {
  return (
    (model.bom ? "\uFEFF" : "") +
    model.lines.join(model.eol) +
    (model.trailingNewline && model.lines.length ? model.eol : "")
  );
}

// 32 alphanumeric symbols, excluding the confusable 0/o/1/l.
export const HASH_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
const anchorPattern = new RegExp(
  `^(\\d+):([${HASH_ALPHABET}]{3})(?:\\|.*)?$`,
  "s",
);
const prefixPattern = new RegExp(`^\\d+:[${HASH_ALPHABET}]{3}\\|`);

/** Low 15 bits of xxHash32: 32768 tags, independent of the line number. */
export function lineHash(text: string): string {
  const hash = Bun.hash.xxHash32(text);
  return [0, 5, 10]
    .map((shift) => HASH_ALPHABET[(hash >>> shift) & 31])
    .join("");
}

export function anchorOf(lineNo: number, text: string): string {
  return `${lineNo}:${lineHash(text)}`;
}

/** Inclusive, one-based bounds. */
export function formatAnchored(
  lines: string[],
  start = 1,
  end = lines.length,
): string {
  return lines
    .slice(Math.max(1, start) - 1, end)
    .map(
      (line, index) => `${anchorOf(Math.max(1, start) + index, line)}|${line}`,
    )
    .join("\n");
}

function readAnchor(value: string): { line: number; hash: string } | null {
  const match = anchorPattern.exec(value.trim());
  if (!match) return null;
  const line = Number(match[1]);
  return Number.isSafeInteger(line) && line > 0
    ? { line, hash: match[2] ?? "" }
    : null;
}

const anchorSchema = z
  .string()
  .refine((value) => readAnchor(value) !== null, "Invalid anchor");
const insertionAnchorSchema = z.union([
  anchorSchema,
  z
    .string()
    .refine((value) => ["BOF", "EOF"].includes(value.trim()), "Invalid anchor"),
]);
export const editOpSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("replace"),
      anchor: anchorSchema,
      end: anchorSchema.optional(),
      content: z.string(),
    })
    .strict(),
  z
    .object({
      op: z.literal("delete"),
      anchor: anchorSchema,
      end: anchorSchema.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("insert_before"),
      anchor: insertionAnchorSchema,
      content: z.string(),
    })
    .strict(),
  z
    .object({
      op: z.literal("insert_after"),
      anchor: insertionAnchorSchema,
      content: z.string(),
    })
    .strict(),
]);
export const editOpsSchema = z.array(editOpSchema).max(100);
export type EditOp = z.infer<typeof editOpSchema>;
export interface EditError {
  kind: "stale" | "ambiguous" | "invalid";
  opIndex: number;
  anchor: string;
  message: string;
  recovery: string;
}
export type EditResult =
  | { ok: true; text: string; summary: string }
  | { ok: false; error: EditError };

function addRegion(
  rows: Set<number>,
  length: number,
  center: number,
  radius: number,
): void {
  for (
    let n = Math.max(1, center - radius);
    n <= Math.min(length, center + radius);
    n++
  )
    rows.add(n);
}

function boundedRows(rows: string[], maxRows: number): string {
  const selected: string[] = [];
  let bytes = 0;
  for (const row of rows) {
    const size = new TextEncoder().encode(row).length + 1;
    if (selected.length >= maxRows || bytes + size > 8192 - 4) {
      selected.push("…");
      break;
    }
    selected.push(row);
    bytes += size;
  }
  return selected.join("\n");
}

function renderRows(
  lines: string[],
  rows: Set<number>,
  hashed: boolean,
  maxRows = 60,
): string {
  return boundedRows(
    [...rows]
      .sort((a, b) => a - b)
      .map((n) => {
        const text = lines[n - 1] ?? "";
        return `${hashed ? anchorOf(n, text) : n}|${text}`;
      }),
    maxRows,
  );
}

function recoveryFor(lines: string[], anchor: string): string {
  if (!lines.length) return 'File is empty; use anchor "BOF".';
  const parsed = readAnchor(anchor);
  const center = Math.min(lines.length, parsed?.line ?? 1);
  const rows = new Set<number>();
  addRegion(rows, lines.length, center, 5);
  const sightings: string[] = [];
  if (parsed) {
    for (let i = 0; i < lines.length && sightings.length < 3; i++) {
      if (i + 1 !== parsed.line && lineHash(lines[i] ?? "") === parsed.hash) {
        sightings.push(`hash seen at line ${i + 1}`);
        addRegion(rows, lines.length, i + 1, 2);
      }
    }
  }
  return boundedRows(
    [
      `Current lines ${Math.max(1, center - 5)}-${Math.min(lines.length, center + 5)}; retry with these anchors.`,
      ...sightings,
      ...renderRows(lines, rows, true).split("\n"),
    ],
    64,
  );
}

function contentLines(content: string): string[] {
  const lines = content.replace(/\r/g, "").split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines.every((line) => prefixPattern.test(line))
    ? lines.map((line) => line.replace(prefixPattern, ""))
    : lines;
}

export function anchorRecovery(text: string, anchor: string): string {
  return recoveryFor(parseText(text).lines, anchor);
}

export function replaceRecovery(text: string, old: string): string {
  const model = parseText(text);
  if (!model.lines.length) return 'File is empty; use anchor "BOF".';
  const normalized = serializeText({ ...model, bom: false, eol: "\n" });
  const needle = old.replace(/\r\n/g, "\n");
  const rows = new Set<number>();
  let from = 0;
  for (let count = 0; needle && count < 10; count++) {
    const offset = normalized.indexOf(needle, from);
    if (offset < 0) break;
    addRegion(
      rows,
      model.lines.length,
      normalized.slice(0, offset).split("\n").length,
      1,
    );
    from = offset + needle.length;
  }
  if (!rows.size && needle) {
    const candidate = model.lines.findIndex(
      (line) => line.trim() === needle.split("\n")[0]?.trim(),
    );
    if (candidate >= 0) addRegion(rows, model.lines.length, candidate + 1, 5);
  }
  return renderRows(model.lines, rows, false);
}

export function applyEdits(text: string, ops: unknown): EditResult {
  const model = parseText(text);
  const fail = (
    kind: EditError["kind"],
    opIndex: number,
    anchor: string,
    reason: string,
  ): EditResult => ({
    ok: false,
    error: {
      kind,
      opIndex,
      anchor,
      message: `Edit ${opIndex} rejected, nothing written: ${reason}. Retry with the recovery anchors.`,
      recovery: recoveryFor(model.lines, anchor),
    },
  });
  const validated = editOpsSchema.safeParse(ops);
  if (!validated.success) {
    const index = validated.error.issues[0]?.path[0];
    const opIndex = typeof index === "number" ? index + 1 : 1;
    const raw = Array.isArray(ops) ? ops[opIndex - 1] : null;
    const anchor =
      raw && typeof raw === "object" && typeof raw.anchor === "string"
        ? raw.anchor
        : "";
    return fail(
      "invalid",
      opIndex,
      anchor,
      validated.error.issues[0]?.message ?? "invalid edits",
    );
  }
  type Line = { text: string; origin: number | null; changed: boolean };
  const lines: Line[] = model.lines.map((text, origin) => ({
    text,
    origin,
    changed: false,
  }));
  const descriptions: string[] = [];
  const deletionContext = new Set<Line>();
  for (const [index, op] of validated.data.entries()) {
    const resolve = (anchor: string): number | "stale" | "ambiguous" => {
      const parsed = readAnchor(anchor);
      if (!parsed) return "stale";
      const positions = new Set<number>();
      if (
        lines[parsed.line - 1] &&
        lineHash(lines[parsed.line - 1]?.text ?? "") === parsed.hash
      )
        positions.add(parsed.line - 1);
      const original = lines.findIndex(
        (line) => line.origin === parsed.line - 1,
      );
      if (
        original >= 0 &&
        lineHash(lines[original]?.text ?? "") === parsed.hash
      )
        positions.add(original);
      return positions.size > 1
        ? "ambiguous"
        : (positions.values().next().value ?? "stale");
    };
    const keyword = op.anchor.trim();
    const start =
      keyword === "BOF"
        ? 0
        : keyword === "EOF"
          ? lines.length
          : resolve(op.anchor);
    if (typeof start !== "number")
      return fail(
        start,
        index + 1,
        op.anchor,
        `anchor ${op.anchor} is ${start}`,
      );
    let end = start;
    if ("end" in op && op.end !== undefined) {
      const resolved = resolve(op.end);
      if (typeof resolved !== "number")
        return fail(
          resolved,
          index + 1,
          op.end,
          `anchor ${op.end} is ${resolved}`,
        );
      end = resolved;
      if (end < start)
        return fail("invalid", index + 1, op.end, "range end before start");
    }
    const inserting = op.op === "insert_before" || op.op === "insert_after";
    const at =
      inserting &&
      keyword !== "BOF" &&
      keyword !== "EOF" &&
      op.op === "insert_after"
        ? start + 1
        : start;
    const count = inserting ? 0 : end - start + 1;
    const replacement =
      op.op === "delete"
        ? []
        : contentLines(op.content).map(
            (text, offset): Line => ({
              text,
              origin: inserting
                ? null
                : offset < count
                  ? (lines[at + offset]?.origin ?? null)
                  : null,
              changed: true,
            }),
          );
    // Avoid argument-count limits when inserting large content blocks.
    const tail = lines.splice(at, lines.length - at);
    for (const line of replacement) lines.push(line);
    for (let i = count; i < tail.length; i++) {
      const line = tail[i];
      if (line) lines.push(line);
    }
    if (!replacement.length) {
      const before = lines[at - 1];
      const after = lines[at];
      if (before) deletionContext.add(before);
      if (after) deletionContext.add(after);
    }
    descriptions.push(
      inserting
        ? `${replacement.length} line(s) inserted ${op.op === "insert_after" ? "after" : "before"} ${keyword}`
        : `lines ${start + 1}-${end + 1} ${op.op === "delete" ? "deleted" : "replaced"}`,
    );
  }
  const updated = lines.map((line) => line.text);
  const rows = new Set<number>();
  lines.forEach((line, i) => {
    if (line.changed) addRegion(rows, lines.length, i + 1, 1);
    else if (deletionContext.has(line)) rows.add(i + 1);
  });
  return {
    ok: true,
    text: serializeText({ ...model, lines: updated }),
    summary: `Applied ${validated.data.length} edits: ${descriptions.join(", ")}${updated.length ? `\n${renderRows(updated, rows, true, 40)}` : "\nFile is empty; use BOF."}`,
  };
}

export function applyReplace(
  text: string,
  old: string,
  replacement: string,
  replaceAll = false,
  maxResultBytes?: number,
): EditResult {
  const model = parseText(text);
  const normalized = serializeText({ ...model, bom: false, eol: "\n" });
  const needle = old.replace(/\r\n/g, "\n");
  const value = replacement.replace(/\r\n/g, "\n");
  const offsets: number[] = [];
  if (needle) {
    let from = 0;
    for (;;) {
      const offset = normalized.indexOf(needle, from);
      if (offset < 0) break;
      offsets.push(offset);
      from = offset + needle.length;
    }
  }
  if (!needle || offsets.length === 0 || (offsets.length > 1 && !replaceAll)) {
    const matchLines: number[] = [];
    let cursor = 0;
    let line = 1;
    for (const offset of offsets.slice(0, 10)) {
      while (cursor < offset) {
        if (normalized[cursor++] === "\n") line++;
      }
      matchLines.push(line);
    }
    const reason = !needle
      ? "old must be non-empty"
      : offsets.length === 0
        ? "no exact match"
        : `multiple matches at lines ${matchLines.slice(0, 10).join(", ")}; add surrounding context or set replace_all`;
    return {
      ok: false,
      error: {
        kind: "invalid",
        opIndex: 1,
        anchor: "",
        message: `Replace rejected, nothing written: ${reason}.`,
        recovery: replaceRecovery(text, old),
      },
    };
  }
  if (maxResultBytes !== undefined) {
    const newlines = (text: string) => {
      let count = 0;
      for (let i = 0; i < text.length; i++) {
        if (text[i] === "\n") count++;
      }
      return count;
    };
    const resultBytes =
      Buffer.byteLength(normalized, "utf8") +
      offsets.length *
        (Buffer.byteLength(value, "utf8") - Buffer.byteLength(needle, "utf8")) +
      (model.bom ? 3 : 0) +
      (model.eol === "\r\n"
        ? newlines(normalized) +
          offsets.length * (newlines(value) - newlines(needle))
        : 0);
    if (resultBytes > maxResultBytes) {
      const limit =
        maxResultBytes === 1024 * 1024 ? "1 MiB" : `${maxResultBytes} byte`;
      return {
        ok: false,
        error: {
          kind: "invalid",
          opIndex: 1,
          anchor: "",
          message: `Edited file exceeds ${limit} limit; nothing written.`,
          recovery: "",
        },
      };
    }
  }
  const result = normalized.split(needle).join(value);
  const updated = parseText(result);
  const rows = new Set<number>();
  let delta = 0;
  let cursor = 0;
  let start = 1;
  const replacementLines = value.split("\n").length;
  for (const offset of offsets) {
    while (cursor < offset + delta) {
      if (result[cursor++] === "\n") start++;
    }
    for (let i = 0; i < replacementLines && rows.size < 40; i++)
      addRegion(rows, updated.lines.length, start + i, 1);
    if (rows.size >= 40) break;
    delta += value.length - needle.length;
  }
  return {
    ok: true,
    text: serializeText({ ...updated, bom: model.bom, eol: model.eol }),
    summary: `Replaced ${offsets.length} match(es).\n${renderRows(updated.lines, rows, false, 40)}`,
  };
}
