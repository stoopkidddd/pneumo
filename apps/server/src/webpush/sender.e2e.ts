import { randomUUID } from "node:crypto";
import { uuidv7 } from "@pneumo/protocol";
import { expect, inject, test, vi } from "vitest";
import webPush from "web-push";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { DeviceRegistry } from "../devices/registry.js";
import { EventBus } from "../events.js";
import { FileRegistry } from "../files/registry.js";
import { PushIndex } from "../index-store/index.js";
import { InstanceState } from "../instance/state.js";
import { createLogger } from "../log.js";
import { S3Storage } from "../storage/s3.js";
import { startWebPushSender } from "./sender.js";
import { loadVapidKeys } from "./vapid.js";

const minio = inject("minio");
const envelope = {
  v: 1 as const,
  n: Buffer.alloc(12, 1).toString("base64url"),
  c: Buffer.alloc(16, 2).toString("base64url"),
};

async function cleanStorage(storage: S3Storage): Promise<void> {
  const keys: string[] = [];
  for await (const object of storage.list("")) keys.push(object.key);
  if (keys.length > 0) await storage.deleteMany(keys);
}

test("MinIO persists Web Push subscription cleanup from HTTP and reconciled pushes", async () => {
  const config = loadConfig({
    ...minio,
    PUBLIC_URL: "https://pneumo.example.test",
    VAPID_SUBJECT: "mailto:eng255@example.test",
    S3_PREFIX: `eng255/webpush-sender/${randomUUID()}/`,
    PNEUMO_SETUP_TOKEN: "fixed-eng255-setup",
    UPLOAD_MODE: "proxy",
    LOG_LEVEL: "silent",
  });
  const storage = new S3Storage(config);
  const clock = { now: () => Date.parse("2026-10-31T00:00:00.000Z") };
  const logger = createLogger("silent");
  const events = new EventBus();
  let stopSender: (() => void) | undefined;
  const attempts = new Map<string, number>();
  const statuses = new Map<string, number>();
  const sendNotification = vi
    .spyOn(webPush, "sendNotification")
    .mockImplementation(async (subscription) => {
      attempts.set(subscription.endpoint, (attempts.get(subscription.endpoint) ?? 0) + 1);
      const statusCode = statuses.get(subscription.endpoint);
      if (statusCode === undefined) throw new Error("Unexpected mocked Web Push subscription");
      throw Object.assign(new Error("Mock Web Push response"), { statusCode });
    });

  try {
    const instanceState = await InstanceState.load({ storage, clock, config, logger });
    const devices = await DeviceRegistry.load({ storage, clock, events });
    const source = await devices.create({ name: "ENG-255 sender", platform: "cli" });
    const stale404 = await devices.create({ name: "Stale 404", platform: "web" });
    const stale410 = await devices.create({ name: "Stale 410", platform: "web" });
    const retained500 = await devices.create({ name: "Retained 500", platform: "web" });
    const subscription404 = {
      endpoint: "https://push.example.test/eng255-404",
      keys: {
        p256dh: Buffer.alloc(65, 4).toString("base64url"),
        auth: Buffer.alloc(16, 4).toString("base64url"),
      },
    };
    const subscription410 = {
      endpoint: "https://push.example.test/eng255-410",
      keys: {
        p256dh: Buffer.alloc(65, 5).toString("base64url"),
        auth: Buffer.alloc(16, 5).toString("base64url"),
      },
    };
    const subscription500 = {
      endpoint: "https://push.example.test/eng255-500",
      keys: {
        p256dh: Buffer.alloc(65, 6).toString("base64url"),
        auth: Buffer.alloc(16, 6).toString("base64url"),
      },
    };
    statuses.set(subscription404.endpoint, 404);
    statuses.set(subscription410.endpoint, 410);
    statuses.set(subscription500.endpoint, 500);
    expect(await devices.setWebPush(stale404.device.id, subscription404)).toBe(true);
    expect(await devices.setWebPush(stale410.device.id, subscription410)).toBe(true);
    expect(await devices.setWebPush(retained500.device.id, subscription500)).toBe(true);

    const pushes = await PushIndex.load({ storage, events });
    const oldEvents = new EventBus();
    const oldPushes = await PushIndex.load({ storage, events: oldEvents });
    const files = new FileRegistry();
    const vapidKeys = await loadVapidKeys({ storage, config });
    const appDependencies = {
      storage,
      clock,
      config,
      logger,
      instanceState,
      devices,
      files,
      uploadMode: "proxy" as const,
      vapidPublicKey: vapidKeys.publicKey,
    };
    const app = createApp({ ...appDependencies, pushes });
    const oldApp = createApp({ ...appDependencies, pushes: oldPushes });
    const request = (targetDeviceId: string): RequestInit => ({
      method: "POST",
      headers: {
        Authorization: `Bearer ${source.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id: uuidv7(), targetDeviceId, envelope, file: null }),
    });

    stopSender = startWebPushSender({ devices, events, config, vapidKeys, clock, logger });

    const removedBy404 = await app.request("/api/pushes", request(stale404.device.id));
    expect(removedBy404.status).toBe(201);
    await vi.waitFor(
      async () => {
        const reloaded = await DeviceRegistry.load({ storage, clock, events: new EventBus() });
        expect(reloaded.getWebPush(stale404.device.id) === null).toBe(true);
      },
      { timeout: 5_000, interval: 25 },
    );
    expect((attempts.get(subscription404.endpoint) ?? 0) === 1).toBe(true);

    const keptBy500 = await app.request("/api/pushes", request(retained500.device.id));
    expect(keptBy500.status).toBe(201);
    await vi.waitFor(
      async () => {
        const reloaded = await DeviceRegistry.load({ storage, clock, events: new EventBus() });
        expect((attempts.get(subscription500.endpoint) ?? 0) === 1).toBe(true);
        expect(
          JSON.stringify(reloaded.getWebPush(retained500.device.id)) ===
            JSON.stringify(subscription500),
        ).toBe(true);
      },
      { timeout: 5_000, interval: 25 },
    );

    const persistedByOldInstance = await oldApp.request("/api/pushes", request(stale410.device.id));
    expect(persistedByOldInstance.status).toBe(201);
    expect((attempts.get(subscription410.endpoint) ?? 0) === 0).toBe(true);
    await pushes.reconcile();
    await vi.waitFor(
      async () => {
        const reloaded = await DeviceRegistry.load({ storage, clock, events: new EventBus() });
        expect(reloaded.getWebPush(stale410.device.id) === null).toBe(true);
      },
      { timeout: 5_000, interval: 25 },
    );
    expect((attempts.get(subscription410.endpoint) ?? 0) === 1).toBe(true);
    expect(sendNotification).toHaveBeenCalledTimes(3);
  } finally {
    stopSender?.();
    sendNotification.mockRestore();
    try {
      await cleanStorage(storage);
    } finally {
      storage.destroy();
    }
  }
});
