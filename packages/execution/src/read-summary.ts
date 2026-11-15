import { extname } from "node:path";
import { z } from "zod";

export const MAX_READ_BYTES = 128 * 1024;
const MAX_OUTLINE_LINE_CHARS = 512;
export const ReadSummaryOptionsSchema = z
  .object({
    thresholdBytes: z
      .number()
      .int()
      .positive()
      .max(MAX_READ_BYTES)
      .default(24 * 1024),
    headLines: z.number().int().nonnegative().max(40).default(12),
    maxSymbols: z.number().int().positive().max(100).default(60),
  })
  .strict();
export type ReadSummaryOptions = z.input<typeof ReadSummaryOptionsSchema>;
export const ReadRequestSchema = z
  .object({
    path: z.string().min(1).max(4096),
    start_line: z.number().int().positive().optional(),
    end_line: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.start_line === undefined ||
      input.end_line === undefined ||
      input.start_line <= input.end_line,
    "start_line must not exceed end_line",
  );

export interface OutlineSymbol {
  label: string;
  startLine: number;
  endLine: number;
}

function fileLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [""];
}

export function structuralOutline(
  path: string,
  text: string,
  maxSymbols = 60,
): { symbols: OutlineSymbol[]; truncated: boolean } {
  const lines = fileLines(text);
  const extension = extname(path).toLowerCase();
  const markdown = [".md", ".mdx", ".markdown"].includes(extension);
  const python = extension === ".py";
  const braceLanguage = [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".go",
    ".rs",
  ].includes(extension);
  const starts: Array<{ line: number; level: number; label: string }> = [];
  let fenced = false;
  let block = true;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    const line = raw.slice(0, MAX_OUTLINE_LINE_CHARS).trim();
    if (markdown && /^(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    let level = raw.length - raw.trimStart().length;
    let label: string | undefined;
    if (markdown) {
      const heading = /^(#{1,6})\s+(.+)/.exec(line);
      if (heading) {
        label = line;
        level = heading[1]?.length ?? 1;
      }
    } else if (python) {
      if (/^(?:async\s+)?(?:def|class)\s+\w+/.test(line)) label = line;
    } else if (extension === ".go") {
      if (/^(?:func|type)\s+/.test(line)) label = line;
    } else if (extension === ".rs") {
      if (
        /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:fn|struct|impl|enum|trait)\b/.test(
          line,
        )
      )
        label = line;
    } else if (braceLanguage) {
      if (
        /^(?:(?:export|default|declare|abstract|async)\s+)*(?:function\s*\*?\s*\w+|class\s+\w+|interface\s+\w+|type\s+\w+|(?:const|let|var)\s+\w+.*=>)/.test(
          line,
        ) ||
        /^export\s+(?:const|let|var)\s+/.test(line) ||
        (/^(?:(?:public|private|protected|static|async|override|abstract|get|set)\s+)*(?:constructor|[\w$]+)\s*\([^;]*\)\s*(?::[^=]+)?\s*\{/.test(
          line,
        ) &&
          !/^(?:if|for|while|switch|catch|with)\b/.test(line))
      )
        label = line;
    } else if (line && block) {
      label = line;
    }
    block = !line;
    if (label)
      starts.push({ line: index + 1, level, label: label.slice(0, 160) });
  }
  const cap = Math.max(1, Math.min(100, maxSymbols));
  const symbols = starts.slice(0, cap).map((start, index) => {
    let end = lines.length;
    for (let next = index + 1; next < starts.length; next += 1) {
      const sibling = starts[next];
      if (sibling && sibling.level <= start.level) {
        end = sibling.line - 1;
        break;
      }
    }
    if (python) {
      for (let row = start.line; row < end; row += 1) {
        const raw = lines[row] ?? "";
        const trimmed = raw.trimStart();
        if (
          trimmed &&
          !trimmed.startsWith("#") &&
          raw.length - trimmed.length <= start.level
        ) {
          end = row;
          break;
        }
      }
    } else if (braceLanguage) {
      let balance = 0;
      let opened = false;
      for (let row = start.line - 1; row < end; row += 1) {
        const raw = lines[row] ?? "";
        for (const char of raw) {
          if (char === "{") {
            balance += 1;
            opened = true;
          }
          if (char === "}") balance -= 1;
        }
        if (opened && balance <= 0) {
          end = row + 1;
          break;
        }
        if (!opened && raw.trimEnd().endsWith(";")) {
          end = row + 1;
          break;
        }
      }
    }
    return {
      label: start.label,
      startLine: start.line,
      endLine: Math.max(start.line, end),
    };
  });
  return { symbols, truncated: starts.length > cap };
}

export function renderRead(
  path: string,
  content: Uint8Array,
  range: {
    start_line?: number | undefined;
    end_line?: number | undefined;
  } = {},
  options: ReadSummaryOptions = {},
): string {
  const config = ReadSummaryOptionsSchema.parse(options);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  const lines = fileLines(text);
  if (range.start_line !== undefined || range.end_line !== undefined) {
    ReadRequestSchema.parse({ path, ...range });
    const start = range.start_line ?? 1;
    const end = range.end_line ?? lines.length;
    if (start > lines.length || end > lines.length)
      throw new Error(
        `Read range exceeds file length (${lines.length} lines).`,
      );
    const slice = lines.slice(start - 1, end).join("");
    if (Buffer.byteLength(slice, "utf8") > MAX_READ_BYTES)
      throw new Error(
        "File range exceeds tool output limit; request a smaller range.",
      );
    return slice;
  }
  if (content.byteLength <= config.thresholdBytes) return text;
  const outline = structuralOutline(path, text, config.maxSymbols);
  const header = `${path}: ${lines.length} lines, ${content.byteLength} bytes. Outlined because file exceeds the ${config.thresholdBytes}-byte summary threshold.\nHeuristic outline (not AST-exact):`;
  const symbols =
    outline.symbols
      .map((symbol) => `${symbol.startLine}-${symbol.endLine}: ${symbol.label}`)
      .join("\n") || "No structural symbols detected.";
  const preview: string[] = [];
  let bytes = 0;
  for (
    let index = 0;
    index < Math.min(config.headLines, lines.length);
    index += 1
  ) {
    const raw = (lines[index] ?? "").replace(/\r?\n$/, "");
    const clipped = Array.from(raw).slice(0, 240).join("");
    const line = `${index + 1}: ${clipped}${clipped === raw ? "" : " [line truncated]"}`;
    if (bytes + Buffer.byteLength(line, "utf8") > 8 * 1024) {
      preview.push("[head byte limit reached]");
      break;
    }
    preview.push(line);
    bytes += Buffer.byteLength(line, "utf8") + 1;
  }
  return `${header}\n${symbols}${outline.truncated ? "\n[outline symbol limit reached]" : ""}\n\nHead (${Math.min(config.headLines, lines.length)} requested lines; bounded preview):\n${preview.join("\n")}\n\nCall mars_read with path, offset (1-based) and limit (1-2000 lines) for the needed section and edit anchors. Range pages are bounded to ${MAX_READ_BYTES} UTF-8 bytes; follow continuation offsets.`;
}
