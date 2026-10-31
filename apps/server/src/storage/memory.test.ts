import { Buffer } from "node:buffer";
import { expect, test } from "vitest";
import { MemoryBucket, MemoryStorage, useMemoryPresignedRequest } from "./memory.js";
import { storageContract } from "./storage.contract.js";
import type { StorageObject } from "./types.js";

const contractBucket = new MemoryBucket();
storageContract(
  "MemoryStorage",
  (prefix) => ({ storage: new MemoryStorage({ bucket: contractBucket, prefix }) }),
  (storage, request, options) =>
    useMemoryPresignedRequest(storage as MemoryStorage, request, {
      method: options.method,
      ...(options.body === undefined ? {} : { body: options.body }),
      headers: { ...request.headers, ...options.headers },
    }),
);

test("uses the injected clock for object metadata and signed URL expiry", async () => {
  let now = Date.parse("2026-03-04T05:06:07.000Z");
  const storage = new MemoryStorage({ now: () => now });
  await storage.putJson("clock.json", { timed: true });

  const objects: StorageObject[] = [];
  for await (const object of storage.list("clock")) objects.push(object);
  expect(objects).toHaveLength(1);
  expect(objects[0]?.lastModified).toEqual(new Date(now));

  const payload = Buffer.from("expiring payload", "utf8");
  const request = await storage.presignPut("expired.bin", payload.byteLength, 5);
  now += 5_000;
  const response = await useMemoryPresignedRequest(storage, request, {
    method: "PUT",
    body: payload,
    headers: request.headers,
  });
  expect(response.status).toBe(403);
  await response.body?.cancel();
  expect(await storage.head("expired.bin")).toBeNull();
});

test("stores bucket CORS configuration as defensive snapshots", async () => {
  const bucket = new MemoryBucket();
  const firstView = new MemoryStorage({ bucket, prefix: "first" });
  const secondView = new MemoryStorage({ bucket, prefix: "second/" });
  const origins = ["https://one.example", "https://two.example"];

  await firstView.applyCors(origins);
  origins.push("https://mutated.example");
  const rules = await secondView.getCors();
  expect(rules).toEqual([
    {
      allowedOrigins: ["https://one.example", "https://two.example"],
      allowedMethods: ["GET", "PUT", "HEAD"],
      allowedHeaders: ["*"],
      exposeHeaders: ["ETag"],
      maxAgeSeconds: 3_600,
    },
  ]);

  rules[0]?.allowedOrigins.push("https://returned-value.example");
  expect((await firstView.getCors())[0]?.allowedOrigins).toEqual([
    "https://one.example",
    "https://two.example",
  ]);
});

test("returns independent JSON values and exposes the configured bucket origin", async () => {
  const storage = new MemoryStorage({ bucketOrigin: "https://objects.example" });
  await storage.putJson("snapshot.json", { nested: { value: 1 } });

  const first = await storage.getJson<{ nested: { value: number } }>("snapshot.json");
  first.nested.value = 2;
  expect(await storage.getJson("snapshot.json")).toEqual({ nested: { value: 1 } });
  expect(storage.bucketOrigin).toBe("https://objects.example");
});
