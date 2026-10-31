import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { serve } from "@hono/node-server";
import { CreateFileResponse, GetFileResponse, PushDTO, uuidv7 } from "@pneumo/protocol";
import { expect, inject, test } from "vitest";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { DeviceRegistry } from "../devices/registry.js";
import { EventBus } from "../events.js";
import { FileRegistry } from "../files/registry.js";
import { PushIndex, pushObjectKey } from "../index-store/index.js";
import { InstanceState } from "../instance/state.js";
import { createLogger } from "../log.js";
import { S3Storage } from "../storage/s3.js";
import { runOrphanSweep, runRetentionSweep } from "../sweeps/index.js";

const minio = inject("minio");
const envelope = {
  v: 1,
  n: Buffer.alloc(12, 1).toString("base64url"),
  c: Buffer.alloc(16, 2).toString("base64url"),
};

async function request(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new Error("HTTP transfer failed");
  }
}

test.each(["direct", "proxy"] as const)(
  "MinIO %s uploads, attaches, downloads, reloads and deletes encrypted bytes over HTTP",
  async (uploadMode) => {
    const config = loadConfig({
      ...minio,
      PUBLIC_URL: "http://localhost",
      S3_PREFIX: `eng251/transfers/${randomUUID()}/`,
      PNEUMO_SETUP_TOKEN: "fixed-e2e-setup",
      UPLOAD_MODE: uploadMode,
      LOG_LEVEL: "silent",
      RETENTION_DAYS: "2",
    });
    const storage = new S3Storage(config);
    let now = Date.now();
    const clock = { now: () => now };
    const logger = createLogger("silent");
    const events = new EventBus();
    const instanceState = await InstanceState.load({ storage, clock, config, logger });
    const devices = await DeviceRegistry.load({ storage, clock, events });
    const owner = await devices.create({ name: "E2E sender", platform: "cli" });
    const pushes = await PushIndex.load({ storage, events });
    const files = new FileRegistry();
    const app = createApp({
      storage,
      clock,
      config,
      logger,
      instanceState,
      devices,
      pushes,
      files,
      uploadMode,
      vapidPublicKey: "unused",
    });
    const listening = Promise.withResolvers<number>();
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, ({ port }) =>
      listening.resolve(port),
    );
    server.once("error", () => listening.reject(new Error("HTTP server failed")));
    try {
      const origin = `http://127.0.0.1:${await listening.promise}`;
      const headers = { Authorization: `Bearer ${owner.token}` };
      const json = (body: unknown): RequestInit => ({
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (uploadMode === "proxy") {
        const reservation = await request(`${origin}/api/files`, json({ size: 4 }));
        const invalid = CreateFileResponse.parse(await reservation.json());
        for (const size of [3, 5]) {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(Buffer.alloc(size));
              controller.close();
            },
          });
          const rejected = await request(new URL(invalid.upload.url, origin).href, {
            method: "PUT",
            headers,
            body: stream,
            duplex: "half",
          } as RequestInit & { duplex: "half" });
          expect(rejected.status).toBe(400);
          expect(await storage.head(`files/${invalid.fileId}`)).toBeNull();
        }
      }
      const bytes = Buffer.alloc(200_057);
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251;
      const issued = await request(`${origin}/api/files`, json({ size: bytes.length }));
      expect(issued.status).toBe(201);
      const descriptor = CreateFileResponse.parse(await issued.json());
      const uploadUrl = new URL(descriptor.upload.url, origin).href;
      const upload = await request(uploadUrl, {
        method: "PUT",
        headers: { ...(uploadMode === "proxy" ? headers : {}), ...descriptor.upload.headers },
        body: bytes,
      });
      expect(upload.status).toBe(uploadMode === "proxy" ? 204 : 200);
      const pushId = uuidv7();
      const create = await request(
        `${origin}/api/pushes`,
        json({ id: pushId, targetDeviceId: null, envelope, file: { id: descriptor.fileId } }),
      );
      expect(create.status).toBe(201);
      const push = PushDTO.parse(await create.json());
      expect(push.file).toEqual({ id: descriptor.fileId, size: bytes.length });
      const get = await request(`${origin}/api/files/${descriptor.fileId}`, { headers });
      expect(get.status).toBe(200);
      const download = GetFileResponse.parse(await get.json());
      const downloaded = await request(new URL(download.download.url, origin).href, {
        headers: { ...(uploadMode === "proxy" ? headers : {}), ...download.download.headers },
      });
      expect(downloaded.status).toBe(200);
      expect(Buffer.compare(Buffer.from(await downloaded.arrayBuffer()), bytes)).toBe(0);
      const reloaded = await PushIndex.load({ storage, events: new EventBus() });
      expect(reloaded.get(pushId)).toEqual({ v: 1, ...push });
      const remove = await request(`${origin}/api/pushes/${pushId}`, { method: "DELETE", headers });
      expect(remove.status).toBe(204);
      expect(await storage.head(`files/${descriptor.fileId}`)).toBeNull();
      expect(await storage.head(pushObjectKey(push))).toBeNull();

      const orphan = uuidv7();
      await storage.putStream(`files/${orphan}`, Readable.from([Buffer.from([1, 2, 3])]), 3);
      now += 25 * 60 * 60 * 1000;
      await runOrphanSweep({ storage, clock, config, pushes, files, logger });
      expect(await storage.head(`files/${orphan}`)).toBeNull();
      const retainedFile = await request(`${origin}/api/files`, json({ size: 3 }));
      const retainedDescriptor = CreateFileResponse.parse(await retainedFile.json());
      await storage.putStream(
        `files/${retainedDescriptor.fileId}`,
        Readable.from([Buffer.from([4, 5, 6])]),
        3,
      );
      const retained = await request(
        `${origin}/api/pushes`,
        json({
          id: uuidv7(),
          targetDeviceId: null,
          envelope,
          file: { id: retainedDescriptor.fileId },
        }),
      );
      expect(retained.status).toBe(201);
      const retainedPush = PushDTO.parse(await retained.json());
      now += 3 * 24 * 60 * 60 * 1000;
      await runRetentionSweep({ storage, clock, config, pushes, files, logger });
      expect(await storage.head(`files/${retainedDescriptor.fileId}`)).toBeNull();
      expect(await storage.head(pushObjectKey(retainedPush))).toBeNull();
    } finally {
      const closed = Promise.withResolvers<void>();
      server.close((error) => (error ? closed.reject(error) : closed.resolve()));
      await closed.promise;
      try {
        const keys: string[] = [];
        for await (const object of storage.list("")) keys.push(object.key);
        await storage.deleteMany(keys);
      } finally {
        storage.destroy();
      }
    }
  },
);
