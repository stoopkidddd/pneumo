import { b64uEncode } from "@pneumo/crypto";
import type { DeviceDTO, DeviceRecord, WebPushSubscription } from "@pneumo/protocol";
import { expect, test, vi } from "vitest";
import type { Clock } from "../app.js";
import { EventBus } from "../events.js";
import { MemoryStorage } from "../storage/memory.js";
import { DeviceRegistry } from "./registry.js";

const subscription: WebPushSubscription = {
  endpoint: "https://push.example.test/delivery",
  keys: {
    p256dh: b64uEncode(new Uint8Array(65).fill(1)),
    auth: b64uEncode(new Uint8Array(16).fill(2)),
  },
};

function containsSecretFields(value: unknown): boolean {
  const serialized = JSON.stringify(value);
  return (
    serialized.includes("tokenHash") ||
    serialized.includes("webPush") ||
    serialized.includes("token")
  );
}

test("creates reloadable DTOs without exposing persisted token hashes or subscriptions", async () => {
  const storage = new MemoryStorage();
  const clock: Clock = { now: () => Date.parse("2026-02-01T00:00:00.000Z") };
  const registry = await DeviceRegistry.load({ storage, clock, events: new EventBus() });
  const created = await registry.create({ name: "Browser", platform: "web" });
  expect(created.device.online).toBe(false);
  expect(containsSecretFields(created.device)).toBe(false);

  await registry.setWebPush(created.device.id, subscription);
  expect(containsSecretFields(registry.get(created.device.id))).toBe(false);
  expect(containsSecretFields(registry.list())).toBe(false);
  expect(containsSecretFields(await registry.authenticate(created.token))).toBe(false);

  const reloaded = await DeviceRegistry.load({ storage, clock, events: new EventBus() });
  expect(reloaded.get(created.device.id)).toEqual(created.device);
  expect((await reloaded.authenticate(created.token))?.id).toBe(created.device.id);
});

test("applies transient online state to every DTO conversion without persisting it", async () => {
  let now = Date.parse("2026-02-01T00:00:00.000Z");
  const clock: Clock = { now: () => now };
  const storage = new MemoryStorage({ now: clock.now });
  const events = new EventBus();
  const added: DeviceDTO[] = [];
  const updated: DeviceDTO[] = [];
  events.on("device_added", ({ device }) => added.push(device));
  events.on("device_updated", ({ device }) => updated.push(device));
  const registry = await DeviceRegistry.load({ storage, clock, events });
  const created = await registry.create({ name: "Browser", platform: "web" });
  expect(added).toEqual([created.device]);
  expect(created.device.online).toBe(false);

  registry.setOnline(created.device.id, true);
  expect(updated).toEqual([]);
  expect(registry.get(created.device.id)?.online).toBe(true);
  expect(registry.list()).toEqual([{ ...created.device, online: true }]);
  expect((await registry.authenticate(created.token))?.online).toBe(true);

  now += 60_000;
  const seen = await registry.authenticate(created.token);
  expect(seen?.online).toBe(true);
  expect(updated.at(-1)).toEqual(seen);
  const renamed = await registry.rename(created.device.id, "Primary browser");
  expect(renamed?.online).toBe(true);
  expect(updated.at(-1)).toEqual(renamed);

  const persisted = await storage.getJson<Record<string, unknown>>(
    `devices/${created.device.id}.json`,
  );
  expect(persisted).not.toHaveProperty("online");

  registry.setOnline(created.device.id, false);
  expect(registry.get(created.device.id)?.online).toBe(false);
  expect((await registry.authenticate(created.token))?.online).toBe(false);
  registry.setOnline(created.device.id, true);

  const reloaded = await DeviceRegistry.load({ storage, clock, events: new EventBus() });
  expect(reloaded.get(created.device.id)?.online).toBe(false);
  expect((await reloaded.authenticate(created.token))?.online).toBe(false);
});

test("throttles concurrent lastSeen writes and preserves racing field updates", async () => {
  let now = Date.parse("2026-02-01T00:00:00.000Z");
  const clock: Clock = { now: () => now };
  const storage = new MemoryStorage({ now: clock.now });
  const events = new EventBus();
  const updates: string[] = [];
  events.on("device_updated", ({ device }) => updates.push(device.lastSeenAt));
  const registry = await DeviceRegistry.load({ storage, clock, events });
  const created = await registry.create({ name: "Browser", platform: "web" });
  const putJson = vi.spyOn(storage, "putJson");
  putJson.mockClear();

  now += 59_999;
  await Promise.all(Array.from({ length: 4 }, () => registry.authenticate(created.token)));
  expect(putJson).not.toHaveBeenCalled();

  now += 1;
  const authenticated = await Promise.all(
    Array.from({ length: 8 }, () => registry.authenticate(created.token)),
  );
  expect(authenticated.every((device) => device?.lastSeenAt === new Date(now).toISOString())).toBe(
    true,
  );
  expect(putJson).toHaveBeenCalledTimes(1);
  expect(updates).toHaveLength(1);

  putJson.mockClear();
  now += 60_000;
  await Promise.all([
    registry.authenticate(created.token),
    registry.rename(created.device.id, "Renamed browser"),
    registry.setWebPush(created.device.id, subscription),
  ]);
  const record = await storage.getJson<DeviceRecord>(`devices/${created.device.id}.json`);
  expect(record.name).toBe("Renamed browser");
  expect(record.lastSeenAt).toBe(new Date(now).toISOString());
  expect(JSON.stringify(record.webPush) === JSON.stringify(subscription)).toBe(true);
  expect(putJson).toHaveBeenCalledTimes(3);
});

test("remove wins against queued authentication without resurrecting a record", async () => {
  let now = Date.parse("2026-02-01T00:00:00.000Z");
  const clock: Clock = { now: () => now };
  const storage = new MemoryStorage({ now: clock.now });
  const events = new EventBus();
  const eventOrder: string[] = [];
  events.on("device_removed", ({ id }) => eventOrder.push(`removed:${id}`));
  events.on("close_device", ({ deviceId, code }) => eventOrder.push(`closed:${deviceId}:${code}`));
  const registry = await DeviceRegistry.load({ storage, clock, events });
  const created = await registry.create({ name: "CLI", platform: "cli" });
  registry.setOnline(created.device.id, true);
  now += 60_000;

  const deletion = registry.remove(created.device.id);
  const authentication = registry.authenticate(created.token);
  expect(await deletion).toBe(true);
  expect(await authentication).toBeNull();
  expect(await registry.authenticate(created.token)).toBeNull();
  expect(await storage.head(`devices/${created.device.id}.json`)).toBeNull();
  expect(eventOrder).toEqual([`removed:${created.device.id}`, `closed:${created.device.id}:4401`]);
  registry.setOnline(created.device.id, true);
  expect(registry.get(created.device.id)).toBeNull();
});

test("stores and clears a valid Web Push subscription and rejects invalid material", async () => {
  const storage = new MemoryStorage();
  const registry = await DeviceRegistry.load({
    storage,
    clock: { now: () => Date.parse("2026-02-01T00:00:00.000Z") },
    events: new EventBus(),
  });
  const created = await registry.create({ name: "Browser", platform: "web" });
  await expect(
    registry.setWebPush(created.device.id, {
      ...subscription,
      keys: { ...subscription.keys, auth: "invalid" },
    }),
  ).rejects.toThrow();
  expect(await registry.setWebPush(created.device.id, subscription)).toBe(true);
  const persisted = await storage.getJson<DeviceRecord>(`devices/${created.device.id}.json`);
  expect(JSON.stringify(persisted.webPush) === JSON.stringify(subscription)).toBe(true);
  expect(await registry.setWebPush(created.device.id, null)).toBe(true);
  const cleared = await storage.getJson<DeviceRecord>(`devices/${created.device.id}.json`);
  expect(cleared.webPush === null).toBe(true);
});
