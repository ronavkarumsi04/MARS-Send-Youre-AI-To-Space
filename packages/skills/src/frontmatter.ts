/**
 * Minimal, dependency-free parser for the YAML subset allowed in SKILL.md
 * frontmatter: a flat mapping of scalar `key: value` pairs. Anchors, aliases,
 * nested structures, flow collections and duplicate keys are rejected so the
 * parser cannot be used for billion-laughs or type-confusion tricks.
 */
export interface Frontmatter {
  name?: string;
  description?: string;
  [key: string]: string | undefined;
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

function unquote(value: string): string | undefined {
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    return value.slice(1, -1).replaceAll("''", "'");
  if (/^[&*!|>{}[\]%@`]/.test(value)) return undefined;
  const comment = value.indexOf(" #");
  return (comment >= 0 ? value.slice(0, comment) : value).trim();
}

export function parseFrontmatter(content: string): Frontmatter | undefined {
  const match = FENCE.exec(content);
  if (!match || match[1] === undefined) return undefined;
  const data: Frontmatter = {};
  for (const raw of match[1].split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (line !== line.trimStart()) return undefined;
    const separator = line.indexOf(":");
    if (separator <= 0) return undefined;
    const key = line.slice(0, separator).trim();
    const rest = line.slice(separator + 1);
    if (!KEY.test(key) || key === "__proto__") return undefined;
    if (rest && !rest.startsWith(" ")) return undefined;
    if (Object.hasOwn(data, key)) return undefined;
    const value = unquote(rest.trim());
    if (value === undefined) return undefined;
    data[key] = value;
  }
  return data;
}

/** Read-only import subset; store writes and slash commands keep the flat parser. */
export function parseImportedFrontmatter(
  content: string,
): Frontmatter | undefined {
  const match = FENCE.exec(content);
  if (!match?.[1]) return undefined;
  const lines = match[1].split(/\r?\n/);
  const data: Frontmatter = {};
  const keys = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (/^\s/.test(line) || line.includes("\t")) return undefined;
    const pair = /^([^:]+):(?: (.*))?$/.exec(line.trimEnd());
    if (!pair?.[1]) return undefined;
    const key = pair[1];
    if (!KEY.test(key) || key === "__proto__" || keys.has(key))
      return undefined;
    keys.add(key);
    const value = (pair[2] ?? "").trim();
    const nested: string[] = [];
    while (
      i + 1 < lines.length &&
      (!lines[i + 1]?.trim() || /^ /.test(lines[i + 1] ?? ""))
    ) {
      nested.push(lines[++i] ?? "");
    }
    if (key === "description" && /^[>|]-?$/.test(value)) {
      const nonempty = nested.filter((s) => s.trim());
      const indent = nonempty[0]?.match(/^ +/)?.[0].length;
      if (
        !indent ||
        nonempty.some(
          (s) => s.includes("\t") || s.match(/^ */)?.[0].length !== indent,
        )
      )
        return undefined;
      const body = nested.map((s) => (s.trim() ? s.slice(indent) : ""));
      while (body.at(-1) === "") body.pop();
      let text = "";
      for (let j = 0; j < body.length; j++) {
        text += body[j];
        if (j + 1 < body.length)
          text += value.startsWith(">") && body[j] && body[j + 1] ? " " : "\n";
      }
      // Folded paragraph breaks consume one of the blank line's two line feeds.
      if (value.startsWith(">"))
        text = text.replaceAll(/\n{2,}/g, (run) => run.slice(1));
      data[key] = text + (value.endsWith("-") ? "" : "\n");
      continue;
    }
    const hasNested = nested.some((s) => s.trim());
    if (
      key !== "name" &&
      key !== "description" &&
      (hasNested || /^[[{]/.test(value))
    ) {
      // Opaque optional YAML is never evaluated, expanded, or used as capabilities.
      if (
        nested.some(
          (s) => s.includes("\t") || /(?:^\s*(?:-\s+)?|:\s*)[&*!]/.test(s),
        ) ||
        /^[&*!]/.test(value)
      )
        return undefined;
      continue;
    }
    if (hasNested) return undefined;
    const scalar = unquote(value);
    if (scalar === undefined) return undefined;
    data[key] = scalar;
  }
  return data;
}
