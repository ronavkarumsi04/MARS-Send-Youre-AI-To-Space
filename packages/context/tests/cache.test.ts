import { describe, expect, test } from "bun:test";
import { touchLru } from "../src/cache";

describe("touchLru", () => {
  test("re-touching a key moves it to most recently used", () => {
    const entries = new Map([
      ["a", 1],
      ["b", 2],
    ]);
    touchLru(entries, "a", 10, 3);
    expect([...entries]).toEqual([
      ["b", 2],
      ["a", 10],
    ]);
  });

  test("evicts least recently used entries beyond the limit", () => {
    const entries = new Map<string, number>();
    touchLru(entries, "a", 1, 2);
    touchLru(entries, "b", 2, 2);
    touchLru(entries, "a", 1, 2);
    touchLru(entries, "c", 3, 2);
    expect([...entries.keys()]).toEqual(["a", "c"]);
  });

  test("a zero limit leaves the map empty", () => {
    const entries = new Map([["a", 1]]);
    touchLru(entries, "b", 2, 0);
    expect(entries.size).toBe(0);
  });
});
