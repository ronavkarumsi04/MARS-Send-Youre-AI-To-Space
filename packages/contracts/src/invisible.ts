/**
 * The one invisible-code-point denylist. Every default-ignorable or format
 * code point that renders as nothing (and so can smuggle text past a human
 * reader) is listed here; memory, code-refs and team import it rather than
 * keeping their own copies.
 */

/** Inclusive code-point ranges rejected as invisible. */
export const INVISIBLE_CODE_POINT_RANGES: readonly (readonly [
  number,
  number,
  string,
])[] = [
  [0x00ad, 0x00ad, "soft hyphen"],
  [0x034f, 0x034f, "combining grapheme joiner"],
  [0x061c, 0x061c, "Arabic letter mark"],
  [0x115f, 0x1160, "Hangul choseong/jungseong fillers"],
  [0x17b4, 0x17b5, "Khmer inherent vowels"],
  [0x180b, 0x180f, "Mongolian free variation selectors and vowel separator"],
  [0x200b, 0x200f, "zero-width space/joiners, LRM, RLM"],
  [0x2028, 0x2029, "line and paragraph separators"],
  [0x202a, 0x202e, "bidirectional embedding and override controls"],
  [0x2060, 0x2064, "word joiner and invisible operators"],
  [0x2066, 0x206f, "bidirectional isolates and deprecated format controls"],
  [0x3164, 0x3164, "Hangul filler"],
  [0xfe00, 0xfe0f, "variation selectors"],
  [0xfeff, 0xfeff, "zero-width no-break space / BOM"],
  [0xffa0, 0xffa0, "halfwidth Hangul filler"],
  [0xfff9, 0xfffb, "interlinear annotation controls"],
  [0x1bca0, 0x1bca3, "shorthand format controls"],
  [0x1d173, 0x1d17a, "musical symbol format controls"],
  [0xe0000, 0xe007f, "tag characters"],
  [0xe0100, 0xe01ef, "variation selectors supplement"],
];

/** C0/C1 controls (except tab and newline), DEL, and the ranges above. */
export function isInvisibleCodePoint(codePoint: number): boolean {
  if (codePoint === 0x7f || (codePoint >= 0x80 && codePoint <= 0x9f))
    return true;
  if (codePoint < 0x20) return codePoint !== 0x09 && codePoint !== 0x0a;
  for (const [start, end] of INVISIBLE_CODE_POINT_RANGES)
    if (codePoint >= start && codePoint <= end) return true;
  return false;
}

export function hasInvisibleCodePoint(text: string): boolean {
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (isInvisibleCodePoint(codePoint)) return true;
  }
  return false;
}
