import { Buffer } from "node:buffer";
import { type Readable as NodeReadable, Readable, Writable } from "node:stream";
import {
  CreateFileResponse,
  ErrorBody,
  GetFileResponse,
  type SetupResponse,
  uuidv7,
} from "@pneumo/protocol";
import type { Hono } from "hono";
import { describe, expect, test, vi } from "vitest";
import { type AppEnv, type Clock, createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { DeviceRegistry } from "../devices/registry.js";
import { EventBus } from "../events.js";
import { PushIndex } from "../index-store/index.js";
import { InstanceState } from "../instance/state.js";
import { createLogger } from "../log.js";
import {
  type MemoryPresignedRequestInit,
  MemoryStorage,
  useMemoryPresignedRequest,
} from "../storage/memory.js";
import type { PresignedRequest } from "../storage/types.js";
import type { UploadMode } from "../storage/upload-mode.js";
import { FileRegistry } from "./registry.js";

const SETUP_TOKEN = "file-route-test-setup";
const INVALID_TOKEN = Buffer.alloc(32, 0xa5).toString("base64url");

class HttpPresignMemoryStorage extends MemoryStorage {
  private readonly requests = new Map<string, PresignedRequest>();
  private nextRequest = 0;

  override async presignPut(
    key: string,
    size: number,
    expiresSec: number,
  ): Promise<PresignedRequest> {
    return this.publicRequest(await super.presignPut(key, size, expiresSec));
  }

  override async presignGet(key: string, expiresSec: number): Promise<PresignedRequest> {
    return this.publicRequest(await super.presignGet(key, expiresSec));
  }

  use(
    request: CreateFileResponse["upload"] | GetFileResponse["download"],
    init: MemoryPresignedRequestInit,
  ): Promise<Response> {
    const memoryRequest = this.requests.get(request.url);
    if (!memoryRequest) return Promise.resolve(new Response(null, { status: 403 }));
    return useMemoryPresignedRequest(this, memoryRequest, init);
  }

  private publicRequest(request: PresignedRequest): PresignedRequest {
    this.nextRequest += 1;
    const url = `https://objects.example.test/presigned/${this.nextRequest}?signature=private`;
    this.requests.set(url, request);
    return { url, headers: request.headers };
  }
}

class ChunkTrackingStorage extends MemoryStorage {
  chunks: number[] = [];

  override async putStream(key: string, stream: NodeReadable, size: number): Promise<void> {
    const captured: Buffer[] = [];
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      this.chunks.push(bytes.byteLength);
      captured.push(bytes);
    }
    await super.putStream(key, Readable.from(captured), size);
  }
}

class EarlyResolveStorage extends MemoryStorage {
  readonly committed = Promise.withResolvers<void>();

  override async putStream(key: string, stream: NodeReadable, size: number): Promise<void> {
    const chunks: Buffer[] = [];
    let consumed = 0;
    for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
      const bytes = chunk as Buffer;
      chunks.push(bytes);
      consumed += bytes.byteLength;
      if (consumed >= size) break;
    }
    await super.putStream(key, Readable.from(chunks), size);
    this.committed.resolve();
  }
}

interface FixtureOptions {
  mode?: UploadMode;
  maxFileBytes?: number;
  storage?: MemoryStorage;
  logLevel?: "silent" | "info";
}

async function fixture(options: FixtureOptions = {}) {
  let now = Date.parse("2026-10-31T12:00:00.000Z");
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const logger = createLogger(options.logLevel ?? "silent", destination);
  const clock: Clock = { now: () => now };
  const config = loadConfig({
    PUBLIC_URL: "https://pneumo.example.test",
    S3_ENDPOINT: "https://objects.example.test",
    S3_BUCKET: "files-test",
    S3_ACCESS_KEY_ID: "fake-access-key",
    S3_SECRET_ACCESS_KEY: "fake-secret-key",
    PNEUMO_SETUP_TOKEN: SETUP_TOKEN,
    MAX_FILE_BYTES: String(options.maxFileBytes ?? 256_000),
    LOG_LEVEL: options.logLevel ?? "silent",
  });
  const storage = options.storage ?? new MemoryStorage({ now: clock.now });
  const events = new EventBus();
  const instanceState = await InstanceState.load({ storage, config, clock, logger });
  const devices = await DeviceRegistry.load({ storage, clock, events });
  const owner = await devices.create({ name: "File test", platform: "web" });
  const pushes = await PushIndex.load({ storage, events });
  const uploadMode = options.mode ?? "proxy";
  const files = new FileRegistry();
  const app = createApp({
    config,
    storage,
    clock,
    logger,
    instanceState,
    devices,
    pushes,
    files,
    uploadMode,
    vapidPublicKey: Buffer.alloc(65, 7).toString("base64url"),
  });
  return {
    app,
    clock,
    config,
    files,
    lines,
    owner,
    pushes,
    storage,
    advance(ms: number) {
      now += ms;
    },
  };
}

function authorization(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function jsonRequest(token: string, body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { ...authorization(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

interface ReservationTarget {
  app: Hono<AppEnv>;
  owner: Pick<SetupResponse, "token">;
}

async function reserve(target: ReservationTarget, size: number) {
  const response = await target.app.request(
    "/api/files",
    jsonRequest(target.owner.token, { size }),
  );
  expect(response.status).toBe(201);
  return CreateFileResponse.parse(await response.json());
}

function streamingPut(
  path: string,
  token: string,
  chunks: readonly Uint8Array[],
  headers: Record<string, string> = {},
): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Request(`http://localhost${path}`, {
    method: "PUT",
    headers: { ...authorization(token), ...headers },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

async function expectError(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(ErrorBody.parse(await response.json()).error.code).toBe(code);
}

describe("file route authentication", () => {
  test.each([
    ["POST", "/api/files"],
    ["GET", "/api/files/019a36f0-7b00-7000-8000-000000000005"],
    ["PUT", "/api/files/019a36f0-7b00-7000-8000-000000000005/content"],
    ["GET", "/api/files/019a36f0-7b00-7000-8000-000000000005/content"],
  ])("%s %s rejects missing and invalid bearer credentials", async (method, path) => {
    const target = await fixture();
    for (const headers of [{}, authorization(INVALID_TOKEN)]) {
      await expectError(await target.app.request(path, { method, headers }), 401, "unauthorized");
    }
  });
});

describe("file reservations", () => {
  test("validates JSON and enforces MAX_FILE_BYTES with 413", async () => {
    const target = await fixture({ maxFileBytes: 10 });
    await expectError(
      await target.app.request("/api/files", {
        method: "POST",
        headers: authorization(target.owner.token),
        body: JSON.stringify({ size: 1 }),
      }),
      400,
      "bad_request",
    );
    await expectError(
      await target.app.request("/api/files", jsonRequest(target.owner.token, { size: -1 })),
      400,
      "bad_request",
    );
    await expectError(
      await target.app.request("/api/files", jsonRequest(target.owner.token, { size: 11 })),
      413,
      "payload_too_large",
    );
    expect((await reserve(target, 10)).upload.url).toMatch(/^\/api\/files\/.+\/content$/u);
  });

  test("returns a UUIDv7 proxy descriptor and records the pending reservation", async () => {
    const target = await fixture();
    const created = await reserve(target, 42);
    expect(created.fileId).toMatch(/^[0-9a-f-]+$/u);
    expect(created.upload).toEqual({
      method: "PUT",
      url: `/api/files/${created.fileId}/content`,
      headers: {},
    });
    expect(created.expiresAt).toBe("2026-10-31T13:00:00.000Z");
    expect(target.files.pending.get(created.fileId)).toEqual({
      size: 42,
      createdAt: target.clock.now(),
      attached: false,
    });
  });
});

describe("proxy transfers", () => {
  test.each([0, 1, 200_057])("round-trips an exact %i-byte body", async (size) => {
    const target = await fixture({ maxFileBytes: 200_057 });
    const created = await reserve(target, size);
    const payload = Buffer.alloc(size, 0x5c);
    const uploaded = await target.app.request(`/api/files/${created.fileId}/content`, {
      method: "PUT",
      headers: {
        ...authorization(target.owner.token),
        "Content-Type": "application/json",
        "Content-Length": String(size),
      },
      body: payload,
    });
    expect(uploaded.status).toBe(204);

    const descriptorResponse = await target.app.request(`/api/files/${created.fileId}`, {
      headers: authorization(target.owner.token),
    });
    expect(descriptorResponse.status).toBe(200);
    expect(GetFileResponse.parse(await descriptorResponse.json())).toEqual({
      download: { url: `/api/files/${created.fileId}/content`, headers: {} },
      expiresAt: "2026-10-31T12:10:00.000Z",
    });
    const downloaded = await target.app.request(`/api/files/${created.fileId}/content`, {
      headers: authorization(target.owner.token),
    });
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("content-type")).toBe("application/octet-stream");
    expect(downloaded.headers.get("content-length")).toBe(String(size));
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(payload);
  });

  test("passes request chunks through incrementally without route-level buffering", async () => {
    const storage = new ChunkTrackingStorage();
    const target = await fixture({ storage });
    const created = await reserve(target, 9);
    const request = streamingPut(`/api/files/${created.fileId}/content`, target.owner.token, [
      Buffer.from("one"),
      Buffer.from("two"),
      Buffer.from("six"),
    ]);
    expect((await target.app.request(request)).status).toBe(204);
    expect(storage.chunks).toEqual([3, 3, 3]);
  });

  test("rejects short and long streams without storing an object", async () => {
    const target = await fixture();
    const short = await reserve(target, 4);
    await expectError(
      await target.app.request(
        streamingPut(`/api/files/${short.fileId}/content`, target.owner.token, [
          Buffer.from("abc"),
        ]),
      ),
      400,
      "bad_request",
    );
    expect(await target.storage.head(`files/${short.fileId}`)).toBeNull();

    const long = await reserve(target, 4);
    await expectError(
      await target.app.request(
        streamingPut(`/api/files/${long.fileId}/content`, target.owner.token, [
          Buffer.from("abcde"),
        ]),
      ),
      400,
      "bad_request",
    );
    expect(await target.storage.head(`files/${long.fileId}`)).toBeNull();
  });

  test("uses 413 when a proxy body exceeds MAX_FILE_BYTES", async () => {
    const target = await fixture({ maxFileBytes: 4 });
    const created = await reserve(target, 4);
    await expectError(
      await target.app.request(`/api/files/${created.fileId}/content`, {
        method: "PUT",
        headers: { ...authorization(target.owner.token), "Content-Length": "5" },
        body: Buffer.alloc(5),
      }),
      413,
      "payload_too_large",
    );
    await expectError(
      await target.app.request(
        streamingPut(`/api/files/${created.fileId}/content`, target.owner.token, [Buffer.alloc(5)]),
      ),
      413,
      "payload_too_large",
    );
  });

  test("rejects late trailing bytes and removes an object already accepted by storage", async () => {
    const storage = new EarlyResolveStorage();
    const target = await fixture({ storage });
    const created = await reserve(target, 3);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("abc"));
        void storage.committed.promise.then(() => {
          controller.enqueue(Buffer.from("trailing"));
          controller.close();
        });
      },
    });
    const request = new Request(`http://localhost/api/files/${created.fileId}/content`, {
      method: "PUT",
      headers: authorization(target.owner.token),
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await expectError(await target.app.request(request), 400, "bad_request");
    expect(await storage.head(`files/${created.fileId}`)).toBeNull();
  });

  test("maps an errored request stream to 400", async () => {
    const target = await fixture();
    const created = await reserve(target, 4);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("ab"));
        controller.error(new Error("client stream secret"));
      },
    });
    const request = new Request(`http://localhost/api/files/${created.fileId}/content`, {
      method: "PUT",
      headers: authorization(target.owner.token),
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await expectError(await target.app.request(request), 400, "bad_request");
  });

  test("returns safe 404s for invalid, unknown, missing, and wrong-sized objects", async () => {
    const target = await fixture();
    for (const path of [
      "/api/files/not-an-id",
      "/api/files/019a36f0-7b00-7000-8000-000000000005",
      "/api/files/not-an-id/content",
      "/api/files/019a36f0-7b00-7000-8000-000000000005/content",
    ]) {
      await expectError(
        await target.app.request(path, { headers: authorization(target.owner.token) }),
        404,
        "not_found",
      );
    }
    const missing = await reserve(target, 3);
    await expectError(
      await target.app.request(`/api/files/${missing.fileId}`, {
        headers: authorization(target.owner.token),
      }),
      404,
      "not_found",
    );
    await target.storage.putStream(
      `files/${missing.fileId}`,
      Readable.from([Buffer.from("xx")]),
      2,
    );
    await expectError(
      await target.app.request(`/api/files/${missing.fileId}`, {
        headers: authorization(target.owner.token),
      }),
      404,
      "not_found",
    );
  });

  test("serves an attached file known only by the loaded push index", async () => {
    const target = await fixture();
    const fileId = uuidv7();
    const payload = Buffer.from("attached");
    await target.storage.putStream(`files/${fileId}`, Readable.from([payload]), payload.byteLength);
    await target.pushes.mutex.run(async () => {
      expect(
        target.pushes.add({
          v: 1,
          id: uuidv7(),
          createdAt: new Date(target.clock.now()).toISOString(),
          sourceDeviceId: target.owner.device.id,
          targetDeviceId: null,
          envelope: {
            v: 1,
            n: Buffer.alloc(12).toString("base64url"),
            c: Buffer.alloc(16).toString("base64url"),
          },
          file: { id: fileId, size: payload.byteLength },
        }),
      ).toBe(true);
    });
    expect(target.files.pending.has(fileId)).toBe(false);

    const descriptor = await target.app.request(`/api/files/${fileId}`, {
      headers: authorization(target.owner.token),
    });
    expect(descriptor.status).toBe(200);
    const content = await target.app.request(`/api/files/${fileId}/content`, {
      headers: authorization(target.owner.token),
    });
    expect(content.status).toBe(200);
    expect(Buffer.from(await content.arrayBuffer())).toEqual(payload);
    await expectError(
      await target.app.request(`/api/files/${fileId}/content`, {
        method: "PUT",
        headers: {
          ...authorization(target.owner.token),
          "Content-Length": String(payload.byteLength),
        },
        body: payload,
      }),
      409,
      "conflict",
    );
  });

  test("denies overwrite after a file is attached", async () => {
    const target = await fixture();
    const created = await reserve(target, 3);
    await target.pushes.mutex.run(async () => {
      target.files.markAttached(created.fileId);
    });
    await expectError(
      await target.app.request(`/api/files/${created.fileId}/content`, {
        method: "PUT",
        headers: { ...authorization(target.owner.token), "Content-Length": "3" },
        body: Buffer.from("new"),
      }),
      409,
      "conflict",
    );
  });
});

describe("direct transfers", () => {
  test("uses one-hour PUT and ten-minute GET MemoryStorage presigned requests", async () => {
    let now = Date.parse("2026-10-31T12:00:00.000Z");
    const storage = new HttpPresignMemoryStorage({ now: () => now });
    const target = await fixture({ mode: "direct", storage });
    const payload = Buffer.from("encrypted file");
    const created = await reserve(target, payload.byteLength);
    expect(
      (
        await storage.use(created.upload, {
          method: "PUT",
          headers: created.upload.headers,
          body: payload,
        })
      ).status,
    ).toBe(200);

    const response = await target.app.request(`/api/files/${created.fileId}`, {
      headers: authorization(target.owner.token),
    });
    const descriptor = GetFileResponse.parse(await response.json());
    expect(response.status).toBe(200);
    const downloaded = await storage.use(descriptor.download, { method: "GET" });
    expect(downloaded.status).toBe(200);
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(payload);
    now += 600_000;
    expect((await storage.use(descriptor.download, { method: "GET" })).status).toBe(403);
    const upload = { method: "PUT" as const, headers: created.upload.headers, body: payload };
    now += 2_999_999;
    expect((await storage.use(created.upload, upload)).status).toBe(200);
    now += 1;
    expect((await storage.use(created.upload, upload)).status).toBe(403);
  });

  test.each(["PUT", "GET"])(
    "%s proxy content endpoint is unavailable in direct mode",
    async (method) => {
      const target = await fixture({ mode: "direct", storage: new HttpPresignMemoryStorage() });
      const created = await reserve(target, 1);
      await expectError(
        await target.app.request(`/api/files/${created.fileId}/content`, {
          method,
          headers: authorization(target.owner.token),
        }),
        404,
        "not_found",
      );
    },
  );
});

describe("presign failure hygiene", () => {
  test("never logs failed PUT presign errors, URLs, query strings, or credentials", async () => {
    const storage = new HttpPresignMemoryStorage();
    vi.spyOn(storage, "presignPut").mockRejectedValue(
      new Error(
        "https://objects.example.test/private?X-Amz-Signature=private-signature fake-access-key",
      ),
    );
    const target = await fixture({ mode: "direct", storage, logLevel: "info" });
    await expectError(
      await target.app.request("/api/files", jsonRequest(target.owner.token, { size: 1 })),
      500,
      "internal",
    );
    expect(target.files.pending.size).toBe(0);
    for (const secret of ["objects.example", "X-Amz", "private-signature", "fake-access-key"]) {
      expect(target.lines.join("").includes(secret)).toBe(false);
    }
  });

  test("never logs a failed GET presign error", async () => {
    const storage = new HttpPresignMemoryStorage();
    const target = await fixture({ mode: "direct", storage, logLevel: "info" });
    const created = await reserve(target, 1);
    await storage.use(created.upload, {
      method: "PUT",
      headers: created.upload.headers,
      body: Buffer.from([1]),
    });
    vi.spyOn(storage, "presignGet").mockRejectedValue(
      new Error("https://objects.example.test/private?signature=download-secret"),
    );
    await expectError(
      await target.app.request(`/api/files/${created.fileId}`, {
        headers: authorization(target.owner.token),
      }),
      500,
      "internal",
    );
    expect(target.lines.join("")).not.toContain("download-secret");
    expect(target.lines.join("")).not.toContain("objects.example");
  });
});
