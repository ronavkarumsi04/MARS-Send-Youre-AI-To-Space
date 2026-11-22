import { expect, test } from "bun:test";
import { casefold } from "../src/casefold";

test.each([
  ["", ""],
  ["Straße ẞ", "strasse ss"],
  ["İ ﬁ ς", "i\u0307 fi σ"],
  ["Ꭰꭰ", "ᎠᎠ"],
  ["ᾀ", "ἀι"],
  ["ı µ ſ", "ı μ s"],
])("matches Python casefold for %s", (input, expected) => {
  expect(casefold(input)).toBe(expected);
  expect(casefold(expected)).toBe(expected);
});
