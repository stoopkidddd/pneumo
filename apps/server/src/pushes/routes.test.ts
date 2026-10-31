import { Readable, Writable } from "node:stream";
import {
  CreateFileResponse,
  type CreatePushRequest,
  ErrorBody,
  ListPushesResponse,
  PushDTO,
  PushRecord,
  uuidv7,
} from "@pneumo/protocol";
import type { Hono } from "hono";
import { describe, expect, test, vi } from "vitest";
import { type AppEnv, createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { DeviceRegistry } from "../devices/registry.js";
import { EventBus } from "../events.js";
import { FileRegistry } from "../files/registry.js";
import { PushIndex, pushObjectKey } from "../index-store/index.js";
import { InstanceState } from "../instance/state.js";
import { createLogger } from "../log.js";
import { MemoryStorage } from "../storage/memory.js";

const envelope = {
  v: 1 as const,
  n: Buffer.alloc(12, 1).toString("base64url"),
  c: Buffer.alloc(16, 2).toString("base64url"),
};

async function fixture(overrides: NodeJS.ProcessEnv = {}) {
  let now = Date.parse("2026-10-01T00:00:00.000Z");
  const clock = { now: () => now };
  const config = loadConfig({
    PUBLIC_URL: "https://pneumo.example",
    S3_ENDPOINT: "https://objects.example",
    S3_BUCKET: "test-bucket",
    S3_ACCESS_KEY_ID: "fake-access-key",
    S3_SECRET_ACCESS_KEY: "fake-secret-key",
    PNEUMO_SETUP_TOKEN: "fixed-test-setup",
    ...overrides,
  });
  const storage = new MemoryStorage({ now: clock.now });
  const lines: string[] = [];
  const logger = createLogger(
    "info",
    new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    }),
  );
  const events = new EventBus();
  const devices = await DeviceRegistry.load({ storage, clock, events });
  const owner = await devices.create({ name: "Sender", platform: "cli" });
  const instanceState = await InstanceState.load({ storage, clock, config, logger });
  const pushes = await PushIndex.load({ storage, events });
  const files = new FileRegistry();
  const app = createApp({
    storage,
    clock,
    config,
    logger,
    devices,
    instanceState,
    pushes,
    files,
    uploadMode: "proxy",
    vapidPublicKey: "unused",
  });
  const headers = { Authorization: `Bearer ${owner.token}` };
  const json = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    app,
    storage,
    clock,
    config,
    events,
    devices,
    owner,
    pushes,
    files,
    lines,
    headers,
    json,
    advance(ms: number) {
      now += ms;
    },
  };
}

function body(overrides: Partial<CreatePushRequest> = {}): CreatePushRequest {
  return { id: uuidv7(), targetDeviceId: null, envelope, file: null, ...overrides };
}

async function issueFile(
  target: { app: Hono<AppEnv>; json(body: unknown): RequestInit },
  size = 4,
) {
  const response = await target.app.request("/api/files", target.json({ size }));
  expect(response.status).toBe(201);
  return CreateFileResponse.parse(await response.json()).fileId;
}

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(ErrorBody.parse(await response.json()).error.code).toBe(code);
}

describe("push routes", () => {
  test.each([
    ["POST", "/api/pushes"],
    ["GET", "/api/pushes"],
    ["GET", "/api/pushes/019a33b0-4200-7000-8000-000000000001"],
    ["DELETE", "/api/pushes/019a33b0-4200-7000-8000-000000000001"],
  ])("%s %s requires bearer authentication", async (method, path) => {
    const target = await fixture();
    for (const headers of [
      {},
      { Authorization: `Bearer ${Buffer.alloc(32, 9).toString("base64url")}` },
    ]) {
      await expectError(await target.app.request(path, { method, headers }), 401, "unauthorized");
    }
  });

  test("persists a server-timestamped record, returns DTOs, and emits exactly once", async () => {
    const target = await fixture();
    const received: PushDTO[] = [];
    target.events.on("push", ({ push }) => received.push(push));
    const request = body();
    const response = await target.app.request(
      "/api/pushes",
      target.json({ ...request, ignored: true }),
    );
    expect(response.status).toBe(201);
    const push = PushDTO.parse(await response.json());
    expect(push).toEqual({
      ...request,
      createdAt: new Date(target.clock.now()).toISOString(),
      sourceDeviceId: target.owner.device.id,
    });
    expect(await target.storage.getJson(pushObjectKey(push))).toEqual({ v: 1, ...push });
    expect(received).toEqual([push]);
    const get = await target.app.request(`/api/pushes/${push.id}`, { headers: target.headers });
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual(push);
    expect(target.lines.join("").includes(request.envelope.c)).toBe(false);
    expect(target.lines.join("").includes(target.owner.token)).toBe(false);
    await expectError(
      await target.app.request(`/api/pushes/${uuidv7()}`, { headers: target.headers }),
      404,
      "not_found",
    );
  });

  test("orders and paginates 250 pushes across timestamp ties without gaps", async () => {
    const target = await fixture();
    const records: PushDTO[] = [];
    for (let i = 0; i < 250; i += 1) {
      if (i % 3 === 0) target.advance(1);
      const response = await target.app.request("/api/pushes", target.json(body()));
      expect(response.status).toBe(201);
      records.push(PushDTO.parse(await response.json()));
    }
    records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const ids: string[] = [];
    let before: string | null = null;
    do {
      const query = before === null ? "" : `?before=${before}`;
      const response = await target.app.request(`/api/pushes${query}`, { headers: target.headers });
      expect(response.status).toBe(200);
      const page = ListPushesResponse.parse(await response.json());
      expect(page.pushes).toEqual(records.slice(ids.length, ids.length + 50));
      ids.push(...page.pushes.map((push) => push.id));
      before = page.nextBefore;
    } while (before !== null);
    expect(ids).toEqual(records.map((push) => push.id));
    const hundred = await target.app.request("/api/pushes?limit=100", { headers: target.headers });
    expect(ListPushesResponse.parse(await hundred.json()).pushes).toEqual(records.slice(0, 100));
    const one = await target.app.request("/api/pushes?limit=1", { headers: target.headers });
    expect(ListPushesResponse.parse(await one.json())).toEqual({
      pushes: [records[0]],
      nextBefore: records[0]?.id,
    });
    const unknown = await target.app.request(`/api/pushes?before=${uuidv7()}`, {
      headers: target.headers,
    });
    expect(await unknown.json()).toEqual({ pushes: [], nextBefore: null });
  });

  test.each(["limit=0", "limit=101", "limit=1.5", "limit=no", "before=not-a-uuid"])(
    "rejects invalid pagination %s",
    async (query) => {
      const target = await fixture();
      await expectError(
        await target.app.request(`/api/pushes?${query}`, { headers: target.headers }),
        400,
        "bad_request",
      );
    },
  );

  test("retries identical bodies regardless of key order; differing bodies conflict", async () => {
    const target = await fixture();
    const request = body();
    const first = await target.app.request("/api/pushes", target.json(request));
    expect(first.status).toBe(201);
    const stored = await first.json();
    target.advance(5000);
    const retry = await target.app.request(
      "/api/pushes",
      target.json({
        file: null,
        envelope: { c: envelope.c, n: envelope.n, v: 1 },
        targetDeviceId: null,
        id: request.id,
        ignored: 1,
      }),
    );
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(stored);
    await expectError(
      await target.app.request(
        "/api/pushes",
        target.json({
          ...request,
          envelope: { ...envelope, c: Buffer.alloc(16, 3).toString("base64url") },
        }),
      ),
      409,
      "conflict",
    );
    await expectError(
      await target.app.request(
        "/api/pushes",
        target.json({ ...request, targetDeviceId: target.owner.device.id }),
      ),
      409,
      "conflict",
    );
    await expectError(
      await target.app.request("/api/pushes", target.json({ ...request, file: { id: uuidv7() } })),
      409,
      "conflict",
    );
    expect(target.pushes.size).toBe(1);
  });

  test("serializes simultaneous duplicate submissions", async () => {
    const target = await fixture();
    const request = body();
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => target.app.request("/api/pushes", target.json(request))),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 200, 200, 200, 200, 200, 200, 201,
    ]);
    expect(target.pushes.size).toBe(1);
  });

  test("validates UUIDv7, target, JSON content type and body cap", async () => {
    const target = await fixture();
    for (const request of [
      body({ id: "019a33b0-4200-4000-8000-000000000001" }),
      body({ targetDeviceId: uuidv7() }),
    ]) {
      await expectError(
        await target.app.request("/api/pushes", target.json(request)),
        400,
        "bad_request",
      );
    }
    await expectError(
      await target.app.request("/api/pushes", {
        method: "POST",
        headers: target.headers,
        body: JSON.stringify(body()),
      }),
      400,
      "bad_request",
    );
    await expectError(
      await target.app.request(
        "/api/pushes",
        target.json({ ...body(), ignored: "x".repeat(128 * 1024) }),
      ),
      413,
      "payload_too_large",
    );
    const validTarget = await target.app.request(
      "/api/pushes",
      target.json(body({ targetDeviceId: target.owner.device.id })),
    );
    expect(validTarget.status).toBe(201);
  });

  test("counts serialized envelope bytes including the boundary", async () => {
    const size = Buffer.byteLength(JSON.stringify(envelope));
    const exact = await fixture({ MAX_ENVELOPE_BYTES: String(size) });
    expect((await exact.app.request("/api/pushes", exact.json(body()))).status).toBe(201);
    const tooLarge = await fixture({ MAX_ENVELOPE_BYTES: String(size - 1) });
    await expectError(
      await tooLarge.app.request("/api/pushes", tooLarge.json(body())),
      413,
      "payload_too_large",
    );
    expect(tooLarge.pushes.size).toBe(0);
  });

  test("requires an issued, uploaded file of precisely the declared size", async () => {
    const target = await fixture();
    await expectError(
      await target.app.request("/api/pushes", target.json(body({ file: { id: uuidv7() } }))),
      400,
      "bad_request",
    );
    const id = await issueFile(target);
    const request = body({ file: { id } });
    await expectError(
      await target.app.request("/api/pushes", target.json(request)),
      400,
      "bad_request",
    );
    await target.storage.putStream(`files/${id}`, Readable.from([Buffer.alloc(3)]), 3);
    await expectError(
      await target.app.request("/api/pushes", target.json(request)),
      400,
      "bad_request",
    );
    await target.storage.putStream(`files/${id}`, Readable.from([Buffer.alloc(4)]), 4);
    const response = await target.app.request("/api/pushes", target.json(request));
    expect(response.status).toBe(201);
    expect(PushDTO.parse(await response.json()).file).toEqual({ id, size: 4 });
    expect(target.files.pending.get(id)?.attached).toBe(true);
    expect((await target.app.request("/api/pushes", target.json(request))).status).toBe(200);
    await expectError(
      await target.app.request("/api/pushes", target.json(body({ file: { id } }))),
      409,
      "conflict",
    );
  });

  test("prevents simultaneous attachment of the same file to two pushes", async () => {
    const target = await fixture();
    const id = await issueFile(target);
    await target.storage.putStream(`files/${id}`, Readable.from([Buffer.alloc(4)]), 4);
    const responses = await Promise.all(
      [body({ file: { id } }), body({ file: { id } })].map((request) =>
        target.app.request("/api/pushes", target.json(request)),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
  });

  test("does not attach or emit when record persistence fails", async () => {
    const target = await fixture();
    const id = await issueFile(target);
    await target.storage.putStream(`files/${id}`, Readable.from([Buffer.alloc(4)]), 4);
    const event = vi.fn();
    target.events.on("push", event);
    const write = vi
      .spyOn(target.storage, "putJson")
      .mockRejectedValueOnce(new Error("private-record-error"));
    await expectError(
      await target.app.request("/api/pushes", target.json(body({ file: { id } }))),
      500,
      "internal",
    );
    expect(target.files.pending.get(id)?.attached).toBe(false);
    expect(target.pushes.size).toBe(0);
    expect(event).not.toHaveBeenCalled();
    expect(target.lines.join("").includes("private-record-error")).toBe(false);
    write.mockRestore();
  });

  test("deletes the persisted record and file before emitting push_deleted", async () => {
    const target = await fixture();
    const id = await issueFile(target);
    await target.storage.putStream(`files/${id}`, Readable.from([Buffer.alloc(4)]), 4);
    const created = await target.app.request("/api/pushes", target.json(body({ file: { id } })));
    const push = PushDTO.parse(await created.json());
    const deleted: string[] = [];
    target.events.on("push_deleted", ({ id }) => deleted.push(id));
    const response = await target.app.request(`/api/pushes/${push.id}`, {
      method: "DELETE",
      headers: target.headers,
    });
    expect(response.status).toBe(204);
    expect(await target.storage.head(`files/${id}`)).toBeNull();
    expect(await target.storage.head(pushObjectKey(push))).toBeNull();
    expect(target.files.pending.has(id)).toBe(false);
    expect(target.pushes.get(push.id)).toBeNull();
    expect(deleted).toEqual([push.id]);
    await expectError(
      await target.app.request(`/api/pushes/${push.id}`, { headers: target.headers }),
      404,
      "not_found",
    );
    await expectError(
      await target.app.request(`/api/pushes/${push.id}`, {
        method: "DELETE",
        headers: target.headers,
      }),
      404,
      "not_found",
    );
    expect(deleted).toEqual([push.id]);
  });

  test("recognizes boot-loaded file attachments without a pending entry", async () => {
    const target = await fixture();
    const id = uuidv7();
    const record = PushRecord.parse({
      ...body({ file: { id } }),
      file: { id, size: 4 },
      v: 1,
      sourceDeviceId: target.owner.device.id,
      createdAt: new Date(target.clock.now()).toISOString(),
    });
    await target.storage.putJson(pushObjectKey(record), record);
    await target.pushes.reconcile();
    await expectError(
      await target.app.request("/api/pushes", target.json(body({ file: { id } }))),
      409,
      "conflict",
    );
  });
});
