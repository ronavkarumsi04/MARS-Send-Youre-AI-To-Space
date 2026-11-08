import { createHash } from "node:crypto";

/** Why a value was refused as canonical JSON data. */
export type CanonicalJsonFailure =
  | "not_json"
  | "non_finite_number"
  | "undefined_member"
  | "sparse_array"
  | "non_plain_object"
  | "cycle";

export interface CanonicalJsonOptions {
  /** Object members whose value is `undefined`: refused (default) or left out. */
  undefinedMembers?: "reject" | "omit";
  /**
   * Member order in the text. `code-unit` (default) sorts every key by UTF-16
   * code unit. `integer-keys-first` is what `JSON.stringify` emits for a
   * sorted object: array-index keys ("0", "9", "10") first in numeric order,
   * then the rest sorted. Kept for stores whose persisted digests use it.
   */
  keyOrder?: "code-unit" | "integer-keys-first";
  /** Builds the error thrown for a refused value; defaults to `CanonicalJsonError`. */
  error?: (failure: CanonicalJsonFailure) => Error;
}

export class CanonicalJsonError extends Error {
  readonly failure: CanonicalJsonFailure;

  constructor(failure: CanonicalJsonFailure) {
    super("invalid_json");
    this.name = "CanonicalJsonError";
    this.failure = failure;
  }
}

/**
 * Strict JSON-data copy of `value` with object keys sorted: only null,
 * booleans, finite numbers (-0 becomes 0), strings, dense arrays and plain
 * (or null-prototype) acyclic objects are accepted.
 */
export function canonicalValue(
  value: unknown,
  options: CanonicalJsonOptions = {},
): unknown {
  const fail = (failure: CanonicalJsonFailure): never => {
    throw (options.error ?? ((f) => new CanonicalJsonError(f)))(failure);
  };
  const omitUndefined = options.undefinedMembers === "omit";
  const seen = new Set<object>();
  const visit = (current: unknown): unknown => {
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) fail("non_finite_number");
      return Object.is(current, -0) ? 0 : current;
    }
    if (typeof current !== "object") return fail("not_json");
    if (seen.has(current)) fail("cycle");
    seen.add(current);
    try {
      if (Array.isArray(current)) {
        const entries: unknown[] = [];
        for (let index = 0; index < current.length; index += 1) {
          if (!Object.hasOwn(current, index)) fail("sparse_array");
          entries.push(visit(current[index]));
        }
        return entries;
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        fail("non_plain_object");
      }
      const record = current as Record<string, unknown>;
      const output = Object.create(null) as Record<string, unknown>;
      for (const key of Object.keys(record).sort()) {
        const member = record[key];
        if (member === undefined) {
          if (omitUndefined) continue;
          fail("undefined_member");
        }
        output[key] = visit(member);
      }
      return output;
    } finally {
      seen.delete(current);
    }
  };
  return visit(value);
}

function writeCodeUnitOrder(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(writeCodeUnitOrder).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${writeCodeUnitOrder(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Canonical JSON text (sorted keys, no whitespace) used for digests and equality. */
export function canonicalJson(
  value: unknown,
  options: CanonicalJsonOptions = {},
): string {
  const canonical = canonicalValue(value, options);
  return options.keyOrder === "integer-keys-first"
    ? JSON.stringify(canonical)
    : writeCodeUnitOrder(canonical);
}

/** Lowercase hex SHA-256 of a string (UTF-8) or bytes. */
export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
