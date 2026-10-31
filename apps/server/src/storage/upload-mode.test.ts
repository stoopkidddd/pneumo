import { Writable } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { createLogger } from "../log.js";
import { MemoryStorage } from "./memory.js";
import { StorageError } from "./types.js";
import { resolveUploadMode } from "./upload-mode.js";

function fixture() {
  const lines: string[] = [];
  const logger = createLogger(
    "info",
    new Writable({
      write(chunk, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    }),
  );
  const storage = new MemoryStorage();
  const resolve = (mode: "auto" | "direct" | "proxy" = "auto") =>
    resolveUploadMode({ storage, mode, publicUrl: "https://pneumo.example", logger });
  return { storage, lines, resolve };
}

afterEach(() => vi.useRealTimers());

test.each(["direct", "proxy"] as const)("explicit %s never probes bucket CORS", async (mode) => {
  const { storage, lines, resolve } = fixture();
  const apply = vi.spyOn(storage, "applyCors");
  const get = vi.spyOn(storage, "getCors");
  expect(await resolve(mode)).toBe(mode);
  expect(apply).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
  expect(lines).toEqual([]);
});

test("auto selects direct after applying and reading the public-origin CORS policy", async () => {
  const { storage, lines, resolve } = fixture();
  expect(await resolve()).toBe("direct");
  expect(await storage.getCors()).toEqual([
    {
      allowedOrigins: ["https://pneumo.example"],
      allowedMethods: ["GET", "PUT", "HEAD"],
      allowedHeaders: ["*"],
      exposeHeaders: ["ETag"],
      maxAgeSeconds: 3600,
    },
  ]);
  expect(lines.map((line) => JSON.parse(line).uploadMode)).toEqual(["direct"]);
});

test.each(["applyCors", "getCors"] as const)(
  "auto falls back once when %s is unsupported, without provider details",
  async (operation) => {
    const { storage, lines, resolve } = fixture();
    vi.spyOn(storage, operation).mockRejectedValue(new StorageError("Unsupported", operation));
    expect(await resolve()).toBe("proxy");
    const rows = lines.map((line) => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      level: 40,
      uploadMode: "proxy",
      operation,
      reason: "Unsupported",
    });
  },
);

test("unexpected failures are never logged as messages, objects or causes", async () => {
  const { storage, lines, resolve } = fixture();
  vi.spyOn(storage, "applyCors").mockRejectedValue(
    new Error(
      "https://objects.example/private?X-Amz-Signature=fake-private-signature fake-secret fake-access",
    ),
  );
  expect(await resolve()).toBe("proxy");
  expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ reason: "Other", level: 40 });
  for (const sensitive of [
    "objects.example",
    "X-Amz",
    "fake-private-signature",
    "fake-secret",
    "fake-access",
  ]) {
    expect(lines.join("").includes(sensitive)).toBe(false);
  }
});

test("auto retries a briefly missing bucket before deciding direct", async () => {
  vi.useFakeTimers();
  const { storage, lines, resolve } = fixture();
  vi.spyOn(storage, "applyCors").mockRejectedValueOnce(
    new StorageError("NotFound", "applyCors", { bucketMissing: true }),
  );
  const result = resolve();
  await vi.advanceTimersByTimeAsync(1000);
  expect(await result).toBe("direct");
  expect(lines.map((line) => JSON.parse(line).level)).toEqual([30]);
});

test("auto stops retrying a missing bucket after ten seconds with one safe warning", async () => {
  vi.useFakeTimers();
  const { storage, lines, resolve } = fixture();
  vi.spyOn(storage, "applyCors").mockRejectedValue(
    new StorageError("NotFound", "applyCors", { bucketMissing: true }),
  );
  const result = resolve();
  await vi.advanceTimersByTimeAsync(9_999);
  expect(lines).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toBe("proxy");
  expect(lines.map((line) => JSON.parse(line))).toEqual([
    expect.objectContaining({ level: 40, reason: "NotFound", bucketMissing: true }),
  ]);
});

test("ordinary object-not-found failures are not bucket-readiness retries", async () => {
  const { storage, lines, resolve } = fixture();
  const apply = vi
    .spyOn(storage, "applyCors")
    .mockRejectedValue(new StorageError("NotFound", "applyCors"));
  expect(await resolve()).toBe("proxy");
  expect(apply).toHaveBeenCalledTimes(1);
  expect(lines).toHaveLength(1);
});
