import { describe, expect, test } from "bun:test";
import {
  CanonicalJsonError,
  canonicalJson,
  canonicalValue,
  sha256,
} from "./canonical";

const failureOf = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    return error instanceof CanonicalJsonError ? error.failure : "other";
  }
  return undefined;
};

describe("canonicalJson", () => {
  test("sorts keys, drops whitespace and normalizes -0", () => {
    expect(canonicalJson({ b: [1, { d: -0, c: "x" }], a: null })).toBe(
      '{"a":null,"b":[1,{"c":"x","d":0}]}',
    );
  });

  test("key order options reproduce both persisted digest forms", () => {
    const value = { "10": 1, "9": 2, a: 3, "": 4 };
    expect(canonicalJson(value)).toBe('{"":4,"10":1,"9":2,"a":3}');
    expect(canonicalJson(value, { keyOrder: "integer-keys-first" })).toBe(
      '{"9":2,"10":1,"":4,"a":3}',
    );
    expect(canonicalJson(value, { keyOrder: "integer-keys-first" })).toBe(
      JSON.stringify(canonicalValue(value)),
    );
  });

  test("undefined members are rejected by default and omitted on request", () => {
    expect(failureOf(() => canonicalJson({ a: 1, b: undefined }))).toBe(
      "undefined_member",
    );
    expect(
      canonicalJson({ a: 1, b: undefined }, { undefinedMembers: "omit" }),
    ).toBe('{"a":1}');
    expect(
      failureOf(() => canonicalJson([undefined], { undefinedMembers: "omit" })),
    ).toBe("not_json");
  });

  test("refuses values that are not JSON data", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(failureOf(() => canonicalJson(cyclic))).toBe("cycle");
    expect(failureOf(() => canonicalJson({ n: Number.NaN }))).toBe(
      "non_finite_number",
    );
    expect(failureOf(() => canonicalJson(new Date(0)))).toBe(
      "non_plain_object",
    );
    expect(failureOf(() => canonicalJson(new Map()))).toBe("non_plain_object");
    // biome-ignore lint/suspicious/noSparseArray: sparse input under test
    expect(failureOf(() => canonicalJson([1, , 2]))).toBe("sparse_array");
    expect(failureOf(() => canonicalJson(undefined))).toBe("not_json");
    expect(failureOf(() => canonicalJson(() => 1))).toBe("not_json");
    expect(failureOf(() => canonicalJson(1n))).toBe("not_json");
  });

  test("shared, non-cyclic references and null-prototype objects are data", () => {
    const shared = { x: 1 };
    expect(canonicalJson([shared, shared])).toBe('[{"x":1},{"x":1}]');
    const dictionary = Object.create(null) as Record<string, unknown>;
    dictionary.b = 2;
    dictionary.a = 1;
    expect(canonicalJson(dictionary)).toBe('{"a":1,"b":2}');
  });

  test("error factory replaces the thrown error", () => {
    const seen: string[] = [];
    expect(() =>
      canonicalJson(
        { n: Number.POSITIVE_INFINITY },
        {
          error: (failure) => {
            seen.push(failure);
            return new RangeError("custom");
          },
        },
      ),
    ).toThrow(RangeError);
    expect(seen).toEqual(["non_finite_number"]);
  });
});

test("sha256 hashes strings as UTF-8 and bytes verbatim", () => {
  expect(sha256("abc")).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  expect(sha256(new TextEncoder().encode("abc"))).toBe(sha256("abc"));
});
