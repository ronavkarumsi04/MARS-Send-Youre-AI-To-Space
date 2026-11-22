import { describe, expect, test } from "bun:test";
import { HostRateLimiter } from "./rate-limit";
import { parseRobots, robotsDecision } from "./robots";

describe("robots user-agent groups", () => {
  test("an empty User-agent line does not capture every crawler", () => {
    const file = parseRobots(
      "User-agent:\nDisallow: /\n\nUser-agent: *\nDisallow: /private\n",
    );
    expect(robotsDecision(file, "MARSResearchWorker/0.1", "/open")).toEqual({
      allowed: true,
      crawlDelayMs: 0,
    });
    expect(
      robotsDecision(file, "MARSResearchWorker/0.1", "/private/x").allowed,
    ).toBe(false);
  });

  test("an empty User-agent line after a group keeps that group's rules", () => {
    const file = parseRobots(
      "User-agent: *\nDisallow: /a\nUser-agent:\nDisallow: /b\n",
    );
    expect(robotsDecision(file, "MARSResearchWorker/0.1", "/a").allowed).toBe(
      false,
    );
    expect(robotsDecision(file, "MARSResearchWorker/0.1", "/b").allowed).toBe(
      false,
    );
  });
});

describe("host rate limiter", () => {
  test("an aborted wait releases its reserved slot", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const limiter = new HostRateLimiter(
      1000,
      () => now,
      async (ms, signal) => {
        sleeps.push(ms);
        signal.throwIfAborted();
      },
    );
    const live = new AbortController().signal;
    await limiter.acquire("a.example", 0, live);
    const aborted = new AbortController();
    aborted.abort(new Error("cancelled"));
    await expect(
      limiter.acquire("a.example", 0, aborted.signal),
    ).rejects.toThrow("cancelled");
    now = 1000;
    await limiter.acquire("a.example", 0, live);
    expect(sleeps).toEqual([1000]);
  });
});
