import { describe, expect, test } from "bun:test";
import { RateLimiter } from "../src/rate.ts";

describe("RateLimiter", () => {
  test("a burst, then refusal, then a refill at the per-minute rate", () => {
    let now = 0;
    const limiter = new RateLimiter({ perMinute: 10, burst: 5, now: () => now });
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.take("a")).toBe(true);
    }
    expect(limiter.take("a")).toBe(false);
    expect(limiter.take("b")).toBe(true);
    now += 5_999;
    expect(limiter.take("a")).toBe(false);
    now += 2;
    expect(limiter.take("a")).toBe(true);
    now += 10 * 60_000;
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.take("a")).toBe(true);
    }
    expect(limiter.take("a")).toBe(false);
  });
});
