import type { PushRecord } from "@pneumo/protocol";
import { expect, test } from "vitest";
import { EventBus } from "../events.js";
import type { PendingFile } from "../files/registry.js";
import { PushIndex, pushObjectKey } from "../index-store/index.js";
import type { Scheduler } from "../index-store/scheduler.js";
import { createLogger } from "../log.js";
import { MemoryStorage } from "../storage/memory.js";
import { runOrphanSweep, runRetentionSweep, startSweeps } from "./index.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const NOW = Date.parse("2026-02-01T00:00:00.000Z");
const SOURCE_ID = "00000000-0000-7000-8000-000000000000";

function id(value: number): string {
  return `00000000-0000-7000-8000-${value.toString(16).padStart(12, "0")}`;
}

function push(value: number, createdAt: number, fileId: string | null): PushRecord {
  return {
    v: 1,
    id: id(value),
    createdAt: new Date(createdAt).toISOString(),
    sourceDeviceId: SOURCE_ID,
    targetDeviceId: null,
    envelope: { v: 1, n: "AAAAAAAAAAAAAAAA", c: "AAAAAAAAAAAAAAAAAAAAAA" },
    file: fileId === null ? null : { id: fileId, size: 1 },
  };
}

class FakeFiles {
  readonly pending = new Map<string, PendingFile>();
  readonly forgotten: string[] = [];

  forget(idToForget: string): void {
    this.forgotten.push(idToForget);
    this.pending.delete(idToForget);
  }
}

class FakeScheduler implements Scheduler {
  readonly jobs = new Map<number, () => Promise<void>>();

  every(ms: number, callback: () => Promise<void>): () => void {
    this.jobs.set(ms, callback);
    return () => this.jobs.delete(ms);
  }
}

test("orphan sweep respects the 24 hour boundary, boot references, and live pending uploads", async () => {
  let objectTime = NOW - DAY_MS - 1;
  const storage = new MemoryStorage({ now: () => objectTime });
  const oldOrphan = id(1);
  const referenced = id(2);
  const pendingProtected = id(3);
  const exactBoundary = id(4);
  const recent = id(5);
  await storage.putJson(`files/${oldOrphan}`, {});
  await storage.putJson(`files/${referenced}`, {});
  await storage.putJson(`files/${pendingProtected}`, {});
  objectTime = NOW - DAY_MS;
  await storage.putJson(`files/${exactBoundary}`, {});
  objectTime = NOW - DAY_MS + 1;
  await storage.putJson(`files/${recent}`, {});

  const referencedPush = push(20, NOW - 2 * DAY_MS, referenced);
  await storage.putJson(pushObjectKey(referencedPush), referencedPush);
  const pushes = await PushIndex.load({ storage, events: new EventBus() });
  const files = new FakeFiles();
  files.pending.set(pendingProtected, { size: 1, createdAt: NOW - DAY_MS + 1, attached: false });
  const expiredPending = id(6);
  files.pending.set(expiredPending, { size: 1, createdAt: NOW - DAY_MS - 1, attached: false });

  await runOrphanSweep({
    storage,
    clock: { now: () => NOW },
    config: { RETENTION_DAYS: 0 },
    pushes,
    files,
    logger: createLogger("silent"),
  });

  expect(await storage.head(`files/${oldOrphan}`)).toBeNull();
  expect(await storage.head(`files/${referenced}`)).not.toBeNull();
  expect(await storage.head(`files/${pendingProtected}`)).not.toBeNull();
  expect(await storage.head(`files/${exactBoundary}`)).not.toBeNull();
  expect(await storage.head(`files/${recent}`)).not.toBeNull();
  expect(files.pending.has(expiredPending)).toBe(false);
});

test("keeps an expired reservation while its uploaded object is younger than 24 hours", async () => {
  const hour = 60 * 60 * 1_000;
  const fileId = id(7);
  const objectTime = NOW - 23.5 * hour;
  let sweepTime = NOW;
  const storage = new MemoryStorage({ now: () => objectTime });
  await storage.putJson(`files/${fileId}`, {});
  const pushes = await PushIndex.load({ storage, events: new EventBus() });
  const files = new FakeFiles();
  files.pending.set(fileId, {
    size: 1,
    createdAt: NOW - 24.5 * hour,
    attached: false,
  });
  const deps = {
    storage,
    clock: { now: () => sweepTime },
    config: { RETENTION_DAYS: 0 },
    pushes,
    files,
    logger: createLogger("silent"),
  };

  await runOrphanSweep(deps);
  expect(await storage.head(`files/${fileId}`)).not.toBeNull();
  expect(files.pending.has(fileId)).toBe(true);

  sweepTime += hour + 1;
  await runOrphanSweep(deps);
  expect(await storage.head(`files/${fileId}`)).toBeNull();
  expect(files.pending.has(fileId)).toBe(false);
});

test("retention removes only pushes older than the configured days with files and events", async () => {
  const storage = new MemoryStorage({ now: () => NOW });
  const oldFile = id(30);
  const boundaryFile = id(31);
  await storage.putJson(`files/${oldFile}`, {});
  await storage.putJson(`files/${boundaryFile}`, {});
  const old = push(40, NOW - 8 * DAY_MS, oldFile);
  const boundary = push(41, NOW - 7 * DAY_MS, boundaryFile);
  await storage.putJson(pushObjectKey(old), old);
  await storage.putJson(pushObjectKey(boundary), boundary);
  const events = new EventBus();
  const deleted: string[] = [];
  events.on("push_deleted", ({ id: deletedId }) => deleted.push(deletedId));
  const pushes = await PushIndex.load({ storage, events });
  const files = new FakeFiles();
  files.pending.set(oldFile, { size: 1, createdAt: NOW, attached: true });
  files.pending.set(boundaryFile, { size: 1, createdAt: NOW, attached: true });

  await runRetentionSweep({
    storage,
    clock: { now: () => NOW },
    config: { RETENTION_DAYS: 7 },
    pushes,
    files,
    logger: createLogger("silent"),
  });

  expect(pushes.get(old.id)).toBeNull();
  expect(await storage.head(pushObjectKey(old))).toBeNull();
  expect(await storage.head(`files/${oldFile}`)).toBeNull();
  expect(pushes.fileSize(oldFile)).toBeNull();
  expect(pushes.get(boundary.id)).toEqual(boundary);
  expect(await storage.head(`files/${boundaryFile}`)).not.toBeNull();
  expect(pushes.fileSize(boundaryFile)).toBe(1);
  expect(deleted).toEqual([old.id]);
  expect(files.forgotten).toContain(oldFile);
  expect(files.forgotten).not.toContain(boundaryFile);
});

test("zero retention leaves old pushes and files untouched", async () => {
  const storage = new MemoryStorage({ now: () => NOW });
  const fileId = id(50);
  const record = push(51, NOW - 100 * DAY_MS, fileId);
  await storage.putJson(`files/${fileId}`, {});
  await storage.putJson(pushObjectKey(record), record);
  const pushes = await PushIndex.load({ storage, events: new EventBus() });
  const files = new FakeFiles();

  await runRetentionSweep({
    storage,
    clock: { now: () => NOW },
    config: { RETENTION_DAYS: 0 },
    pushes,
    files,
    logger: createLogger("silent"),
  });

  expect(pushes.get(record.id)).toEqual(record);
  expect(await storage.head(pushObjectKey(record))).not.toBeNull();
  expect(await storage.head(`files/${fileId}`)).not.toBeNull();
  expect(files.forgotten).toEqual([]);
});

test("sweep scheduling installs hourly and daily jobs and cancels both", async () => {
  const storage = new MemoryStorage();
  const pushes = await PushIndex.load({ storage, events: new EventBus() });
  const files = new FakeFiles();
  const scheduler = new FakeScheduler();
  const stop = startSweeps({
    storage,
    clock: { now: () => NOW },
    config: { RETENTION_DAYS: 7 },
    pushes,
    files,
    scheduler,
    logger: createLogger("silent"),
  });

  expect([...scheduler.jobs.keys()]).toEqual([60 * 60 * 1_000, DAY_MS]);
  stop();
  expect(scheduler.jobs.size).toBe(0);
});
