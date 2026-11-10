import { secretShapeRegexes } from "@mars/contracts";
import {
  sha256,
  canonicalJson as sharedCanonicalJson,
} from "@mars/contracts/canonical";

export { sha256 };

/** Stable JSON for digests (sorted keys, no whitespace, undefined members omitted). */
export function canonicalJson(value: unknown): string {
  return sharedCanonicalJson(value, { undefinedMembers: "omit" });
}

export function digestOf(value: unknown): string {
  return sha256(canonicalJson(value));
}

const SECRET_PATTERNS = secretShapeRegexes("g");

/** Redacts secret-shaped substrings before text is persisted or shown to a proposer. */
export function scrubSecrets(text: string): string {
  let output = text;
  for (const pattern of SECRET_PATTERNS)
    output = output.replace(pattern, "[redacted]");
  return output;
}

export const TRUNCATION_MARKER = "…[truncated]";

export function bounded(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - TRUNCATION_MARKER.length))}${TRUNCATION_MARKER}`;
}

/**
 * Deterministic PRNG seeded from a string (sha256 → xoshiro128**). Every
 * stochastic choice in the search loop draws from one of these, so a run is
 * replayable from its seed and resumes make the same choices.
 */
export function seededRandom(seed: string): () => number {
  const digest = sha256(seed);
  const state = [0, 8, 16, 24].map(
    (offset) => Number.parseInt(digest.slice(offset, offset + 8), 16) >>> 0,
  ) as [number, number, number, number];
  if (state.every((value) => value === 0)) state[0] = 1;
  return () => {
    const [a, b, c, d] = state;
    const result = Math.imul(rotl(Math.imul(b, 5), 7), 9) >>> 0;
    const t = (b << 9) >>> 0;
    let nc = (c ^ a) >>> 0;
    let nd = (d ^ b) >>> 0;
    const nb = (b ^ nc) >>> 0;
    const na = (a ^ nd) >>> 0;
    nc = (nc ^ t) >>> 0;
    nd = rotl(nd, 11);
    state[0] = na;
    state[1] = nb;
    state[2] = nc;
    state[3] = nd;
    return result / 4294967296;
  };
}

function rotl(value: number, shift: number): number {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

/** Python `random.choices(population, weights, k=1)` semantics on one draw. */
export function weightedChoice<T>(
  items: readonly T[],
  weights: readonly number[],
  random: () => number,
): T {
  if (items.length === 0 || items.length !== weights.length)
    throw new RangeError("weightedChoice needs matching non-empty inputs");
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!(total > 0)) return items[Math.floor(random() * items.length)] as T;
  let threshold = random() * total;
  for (let index = 0; index < items.length; index += 1) {
    threshold -= weights[index] as number;
    if (threshold < 0) return items[index] as T;
  }
  return items[items.length - 1] as T;
}

export function isoNow(now: () => number): string {
  return new Date(now()).toISOString();
}
