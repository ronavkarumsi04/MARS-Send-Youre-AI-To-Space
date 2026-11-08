/**
 * Text rules shared by reactions and search. The invisible-code-point
 * denylist is the shared one from `@mars/contracts`: every default-ignorable or
 * format code point that renders as nothing is rejected, so a reaction key or a
 * search query can never smuggle text past a reader.
 */
import { hasInvisibleCodePoint } from "@mars/contracts";

export {
  hasInvisibleCodePoint,
  INVISIBLE_CODE_POINT_RANGES,
  isInvisibleCodePoint,
} from "@mars/contracts";

/** A reaction key: 1..max UTF-16 units, no whitespace, no invisible code point. */
export function isValidEmoji(
  value: unknown,
  maxChars: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maxChars &&
    !/\s/u.test(value) &&
    !hasInvisibleCodePoint(value)
  );
}

/**
 * ASCII-only case folding, the same folding SQLite's `LIKE` applies without
 * ICU, so the excerpt position agrees with the SQL match. Length-preserving.
 */
export function foldAscii(text: string): string {
  return text.replace(/[A-Z]/g, (char) => char.toLowerCase());
}

/** Escapes `%`, `_` and the escape character for a `LIKE ? ESCAPE '\'` pattern. */
export function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export interface Excerpt {
  text: string;
  cut_before: boolean;
  cut_after: boolean;
}

const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

/**
 * `text.slice(start, end)` moved inwards so it never starts on a low or ends
 * on a high surrogate. Lengths are UTF-16 units, the unit the Zod `max`
 * bounds of the response schemas use.
 */
function sliceWhole(text: string, start: number, end: number): string {
  let from = start;
  let to = Math.min(end, text.length);
  if (from < to && isLowSurrogate(text.charCodeAt(from))) from += 1;
  if (to > from && isHighSurrogate(text.charCodeAt(to - 1))) to -= 1;
  return text.slice(from, to);
}

/** First `maxChars` UTF-16 units. */
export function headExcerpt(text: string, maxChars: number): Excerpt {
  if (text.length <= maxChars)
    return { text, cut_before: false, cut_after: false };
  return {
    text: sliceWhole(text, 0, maxChars),
    cut_before: false,
    cut_after: true,
  };
}

/**
 * Bounded window around the first case-folded hit, in the shape of
 * `excerptAround` in `packages/workbench/src/memory-context.ts`: the hit sits
 * a quarter of the way in. `maxChars` is in UTF-16 units and the window never
 * splits a surrogate pair.
 */
export function excerptAround(
  text: string,
  query: string,
  maxChars: number,
): Excerpt {
  if (text.length <= maxChars)
    return { text, cut_before: false, cut_after: false };
  const hit = foldAscii(text).indexOf(foldAscii(query));
  const first = hit < 0 ? 0 : hit;
  const start = Math.max(
    0,
    Math.min(first - Math.floor(maxChars / 4), text.length - maxChars),
  );
  const window = sliceWhole(text, start, start + maxChars);
  return {
    text: window,
    cut_before: start > 0,
    cut_after: start + maxChars < text.length,
  };
}
