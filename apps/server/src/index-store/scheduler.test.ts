import { afterEach, expect, test, vi } from "vitest";
import { systemScheduler } from "./scheduler.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("system scheduler unreferences its timer and cancellation clears it", () => {
  const timer = { unref: vi.fn() } as unknown as NodeJS.Timeout;
  const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(timer);
  const clearIntervalSpy = vi
    .spyOn(globalThis, "clearInterval")
    .mockImplementation(() => undefined);

  const stop = systemScheduler.every(1_000, async () => undefined);

  expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 1_000);
  expect(timer.unref).toHaveBeenCalledOnce();
  stop();
  expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
});

test("system scheduler never overlaps invocations of one job", async () => {
  vi.useFakeTimers();
  const gate = Promise.withResolvers<void>();
  let calls = 0;
  const stop = systemScheduler.every(1_000, async () => {
    calls += 1;
    if (calls === 1) await gate.promise;
  });

  await vi.advanceTimersByTimeAsync(3_000);
  expect(calls).toBe(1);
  gate.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(calls).toBe(2);
  stop();
});
