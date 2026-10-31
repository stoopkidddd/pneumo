import { type PushRecord, uuidv7 } from "@pneumo/protocol";
import { expect, test } from "vitest";
import { EventBus } from "../events.js";
import { createLogger } from "../log.js";
import { MemoryStorage } from "../storage/memory.js";
import type { StorageObject } from "../storage/types.js";
import { PushIndex, pushObjectKey, startReconciliation } from "./index.js";
import type { Scheduler } from "./scheduler.js";

const SOURCE_ID = "00000000-0000-7000-8000-000000000000";

function push(idNumber: number, createdAt: string, fileId: string | null = null): PushRecord {
  return {
    v: 1,
    id: `00000000-0000-7000-8000-${idNumber.toString(16).padStart(12, "0")}`,
    createdAt,
    sourceDeviceId: SOURCE_ID,
    targetDeviceId: null,
    envelope: { v: 1, n: "AAAAAAAAAAAAAAAA", c: "AAAAAAAAAAAAAAAAAAAAAA" },
    file: fileId === null ? null : { id: fileId, size: 12 },
  };
}

async function storePushes(storage: MemoryStorage, records: readonly PushRecord[]): Promise<void> {
  for (const record of records) await storage.putJson(pushObjectKey(record), record);
}

class ConcurrentGetStorage extends MemoryStorage {
  active = 0;
  maximum = 0;
  calls = 0;

  override async getJson<T>(key: string): Promise<T> {
    this.calls += 1;
    this.active += 1;
    this.maximum = Math.max(this.maximum, this.active);
    const turn = Promise.withResolvers<void>();
    queueMicrotask(turn.resolve);
    await turn.promise;
    try {
      return await super.getJson<T>(key);
    } finally {
      this.active -= 1;
    }
  }
}

class CountingListStorage extends MemoryStorage {
  yielded = 0;

  override async *list(
    prefix: string,
    options: { startAfter?: string; maxKeys?: number } = {},
  ): AsyncIterable<StorageObject> {
    for await (const object of super.list(prefix, options)) {
      this.yielded += 1;
      yield object;
    }
  }
}

class FakeScheduler implements Scheduler {
  readonly jobs = new Map<number, () => Promise<void>>();

  every(ms: number, callback: () => Promise<void>): () => void {
    this.jobs.set(ms, callback);
    return () => this.jobs.delete(ms);
  }

  async tick(ms: number): Promise<void> {
    const callback = this.jobs.get(ms);
    if (callback === undefined) throw new Error("Missing scheduled job");
    await callback();
  }
}

test("boot loads every push with at most 32 concurrent reads and indexes file references", async () => {
  const storage = new ConcurrentGetStorage();
  const records = Array.from({ length: 65 }, (_, index) =>
    push(
      index + 1,
      new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      index === 0 ? uuidv7() : null,
    ),
  );
  await storePushes(storage, records);

  const index = await PushIndex.load({ storage, events: new EventBus() });

  expect(storage.calls).toBe(65);
  expect(storage.maximum).toBe(32);
  expect(index.size).toBe(65);
  expect(index.hasFile(records[0]?.file?.id ?? "")).toBe(true);
  expect(index.fileSize(records[0]?.file?.id ?? "")).toBe(12);
});

test("orders by createdAt and id descending and paginates after a UUID cursor", async () => {
  const storage = new MemoryStorage();
  const records = [
    push(1, "2026-01-02T00:00:00.000Z"),
    push(2, "2026-01-02T00:00:00.000Z"),
    push(3, "2026-01-03T00:00:00.000Z"),
    push(4, "2026-01-01T00:00:00.000Z"),
  ];
  await storePushes(storage, records);
  const index = await PushIndex.load({ storage, events: new EventBus() });

  const first = index.list(undefined, 2);
  expect(first.pushes.map((record) => record.id)).toEqual([records[2]?.id, records[1]?.id]);
  expect(first.nextBefore).toBe(records[1]?.id);
  const second = index.list(first.nextBefore ?? undefined, 2);
  expect(second.pushes.map((record) => record.id)).toEqual([records[0]?.id, records[3]?.id]);
  expect(second.nextBefore).toBeNull();
  expect(index.list("00000000-0000-7000-8000-ffffffffffff", 2)).toEqual({
    pushes: [],
    nextBefore: null,
  });
});

test("reconciliation merges on the 30 second job and emits each push once", async () => {
  const storage = new MemoryStorage();
  const events = new EventBus();
  const scheduler = new FakeScheduler();
  const index = await PushIndex.load({ storage, events });
  const emitted: string[] = [];
  events.on("push", ({ push: dto }) => emitted.push(dto.id));
  const stop = startReconciliation({
    pushes: index,
    scheduler,
    logger: createLogger("silent"),
  });
  const record = push(10, "2026-01-01T00:00:00.000Z");
  await storePushes(storage, [record]);

  await scheduler.tick(30_000);
  await scheduler.tick(30_000);

  expect(index.get(record.id)).toEqual(record);
  expect(emitted).toEqual([record.id]);
  stop();
  expect(scheduler.jobs.size).toBe(0);
});

test("reconciliation never consumes beyond the first 100 storage keys", async () => {
  const storage = new CountingListStorage();
  const records = Array.from({ length: 101 }, (_, index) =>
    push(index + 1, new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()),
  );
  await storePushes(storage, records);
  const index = await PushIndex.load({ storage, events: new EventBus() });
  storage.yielded = 0;

  await index.reconcile();

  expect(storage.yielded).toBe(100);
});

test("rejects a persisted record whose key does not match without exposing its contents", async () => {
  const storage = new MemoryStorage();
  const record = push(1, "2026-01-01T00:00:00.000Z");
  await storage.putJson(pushObjectKey(record), {
    ...record,
    id: push(2, record.createdAt).id,
    secret: "do-not-log",
  });

  await expect(PushIndex.load({ storage, events: new EventBus() })).rejects.toThrow(
    "Invalid persisted push record",
  );
});
