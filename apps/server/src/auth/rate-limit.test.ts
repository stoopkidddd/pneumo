import { expect, test } from "vitest";
import type { Clock } from "../app.js";
import { LoginRateLimiter } from "./rate-limit.js";

test("limits the sixth failure per IP for a rolling fifteen-minute window", () => {
  let now = 1_000_000;
  const clock: Clock = { now: () => now };
  const limiter = new LoginRateLimiter(clock);
  for (let index = 0; index < 5; index += 1) {
    expect(limiter.retryAfter("192.0.2.1")).toBeNull();
    limiter.failure("192.0.2.1");
    now += 1_000;
  }
  expect(limiter.retryAfter("192.0.2.1")).toBe(895);
  now += 895_000;
  expect(limiter.retryAfter("192.0.2.1")).toBeNull();
});

test("success resets the IP counter but preserves the global counter", () => {
  const clock: Clock = { now: () => 2_000_000 };
  const limiter = new LoginRateLimiter(clock);
  for (let address = 1; address <= 6; address += 1) {
    const ip = `198.51.100.${address}`;
    for (let failure = 0; failure < 5; failure += 1) limiter.failure(ip);
    limiter.success(ip);
    expect(limiter.retryAfter(ip)).toBe(address === 6 ? 900 : null);
  }
  expect(limiter.retryAfter("203.0.113.1")).toBe(900);
});

test("Retry-After rounds partial seconds upward", () => {
  let now = 3_000_000;
  const limiter = new LoginRateLimiter({ now: () => now });
  for (let index = 0; index < 5; index += 1) limiter.failure("192.0.2.2");
  now += 1;
  expect(limiter.retryAfter("192.0.2.2")).toBe(900);
});
