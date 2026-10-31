import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { serve } from "@hono/node-server";
import {
  ListDevicesResponse,
  PushDTO,
  PushRecord,
  type ServerFrame,
  ServerFrame as ServerFrameSchema,
  type SetupResponse,
} from "@pneumo/protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { type Clock, createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { DeviceRegistry } from "../devices/registry.js";
import { EventBus } from "../events.js";
import { FileRegistry } from "../files/registry.js";
import { PushIndex } from "../index-store/index.js";
import { InstanceState } from "../instance/state.js";
import { createLogger } from "../log.js";
import { MemoryStorage } from "../storage/memory.js";
import { attachWebSocketHub } from "./hub.js";
import type { WebSocketTimers } from "./timers.js";

const BASE_TIME = Date.parse("2026-10-01T00:00:00.000Z");
const PING_SECONDS = 60;
const ENVELOPE = {
  v: 1 as const,
  n: Buffer.alloc(12, 17).toString("base64url"),
  c: Buffer.from("websocket-secret-ciphertext").toString("base64url"),
};
const HELLO_CLIENT = { platform: "android" as const, version: "0.1.0" };
const FRAME_TIMEOUT_MS = 2_000;
// These watchdogs bound real network failures; protocol time itself uses ManualWebSocketTimers.

interface ScheduledTask {
  readonly id: number;
  dueAt: number;
  readonly interval: number | null;
  readonly callback: () => void;
}

class ManualWebSocketTimers implements WebSocketTimers {
  elapsed = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, ScheduledTask>();

  after(ms: number, callback: () => void): () => void {
    return this.schedule(ms, null, callback);
  }

  every(ms: number, callback: () => void): () => void {
    return this.schedule(ms, ms, callback);
  }

  advance(ms: number): void {
    const end = this.elapsed + ms;
    for (;;) {
      let next: ScheduledTask | undefined;
      for (const task of this.tasks.values()) {
        if (task.dueAt > end) continue;
        if (
          next === undefined ||
          task.dueAt < next.dueAt ||
          (task.dueAt === next.dueAt && task.id < next.id)
        ) {
          next = task;
        }
      }
      if (next === undefined) break;

      this.elapsed = next.dueAt;
      if (next.interval === null) this.tasks.delete(next.id);
      else next.dueAt += next.interval;
      next.callback();
    }
    this.elapsed = end;
  }

  get pendingCount(): number {
    return this.tasks.size;
  }

  private schedule(ms: number, interval: number | null, callback: () => void): () => void {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.set(id, { id, dueAt: this.elapsed + ms, interval, callback });
    return () => this.tasks.delete(id);
  }
}

class TestClient {
  readonly socket: WebSocket;
  readonly opened: Promise<void>;
  readonly closed: Promise<{ code: number }>;
  private readonly values: unknown[] = [];
  private readonly waiters: Array<(value: unknown) => void> = [];

  constructor(url: string) {
    this.socket = new WebSocket(url);
    const opened = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<{ code: number }>();
    let didOpen = false;
    this.opened = opened.promise;
    this.closed = closed.promise;

    this.socket.once("open", () => {
      didOpen = true;
      opened.resolve();
    });
    this.socket.once("close", (code) => {
      closed.resolve({ code });
    });
    this.socket.on("error", (error) => {
      if (!didOpen) opened.reject(error);
    });
    this.socket.on("message", (data, isBinary) => {
      let value: unknown;
      if (isBinary) {
        value = { unexpectedBinaryFrame: true };
      } else {
        try {
          value = JSON.parse(data.toString());
        } catch {
          value = { invalidJsonFrame: true };
        }
      }
      const waiter = this.waiters.shift();
      if (waiter === undefined) this.values.push(value);
      else waiter(value);
    });
  }

  sendJson(value: unknown): void {
    this.socket.send(JSON.stringify(value));
  }

  async nextFrame(): Promise<ServerFrame> {
    const parsed = ServerFrameSchema.safeParse(await this.nextValue());
    if (!parsed.success) throw new Error("Received an invalid server WebSocket frame");
    return parsed.data;
  }

  get pendingFrames(): number {
    return this.values.length;
  }

  terminate(): void {
    if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate();
  }

  private nextValue(): Promise<unknown> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve(value);

    const pending = Promise.withResolvers<unknown>();
    const waiter = (received: unknown) => {
      clearTimeout(timeout);
      pending.resolve(received);
    };
    const timeout = setTimeout(() => {
      const index = this.waiters.indexOf(waiter);
      if (index !== -1) this.waiters.splice(index, 1);
      pending.reject(new Error("Timed out waiting for WebSocket frame"));
    }, FRAME_TIMEOUT_MS);
    this.waiters.push(waiter);
    return pending.promise;
  }
}

interface Fixture {
  readonly timers: ManualWebSocketTimers;
  readonly events: EventBus;
  readonly devices: DeviceRegistry;
  readonly pushes: PushIndex;
  readonly owner: SetupResponse;
  readonly lines: string[];
  connect(): Promise<TestClient>;
  request(path: string, init?: RequestInit): Promise<Response>;
  stopHub(): Promise<void>;
  dispose(): Promise<void>;
}

const fixtures = new Set<Fixture>();

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([...fixtures].map((target) => target.dispose()));
  fixtures.clear();
});

async function fixture(pingSeconds = PING_SECONDS): Promise<Fixture> {
  const timers = new ManualWebSocketTimers();
  const clock: Clock = { now: () => BASE_TIME + timers.elapsed };
  const config = loadConfig({
    PUBLIC_URL: "https://pneumo.example",
    S3_ENDPOINT: "https://objects.example",
    S3_BUCKET: "test-bucket",
    S3_ACCESS_KEY_ID: "fake-access-key",
    S3_SECRET_ACCESS_KEY: "fake-secret-key",
    PNEUMO_SETUP_TOKEN: "fixed-test-setup",
    WS_PING_SECONDS: String(pingSeconds),
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
  const owner = await devices.create({ name: "Owner", platform: "web" });
  const pushes = await PushIndex.load({ storage, events });
  const instanceState = await InstanceState.load({ storage, config, clock, logger });
  const app = createApp({
    config,
    storage,
    clock,
    logger,
    instanceState,
    devices,
    pushes,
    files: new FileRegistry(),
    uploadMode: "proxy",
    vapidPublicKey: "unused",
  });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/api/ws`;
  const shutdown = attachWebSocketHub({
    server,
    devices,
    pushes,
    events,
    clock,
    logger,
    pingSeconds,
    timers,
  });
  const clients = new Set<TestClient>();
  let stopped = false;
  let disposed = false;

  const target: Fixture = {
    timers,
    events,
    devices,
    pushes,
    owner,
    lines,
    async connect() {
      const client = new TestClient(wsUrl);
      clients.add(client);
      await withTimeout(client.opened, "Timed out opening WebSocket");
      return client;
    },
    request(path, init) {
      return fetch(`${baseUrl}${path}`, init);
    },
    async stopHub() {
      if (stopped) return;
      stopped = true;
      await shutdown(1012);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await target.stopHub();
      await settle();
      for (const client of clients) client.terminate();
      await settle();
      const httpServer = server as Server;
      httpServer.closeAllConnections();
      if (httpServer.listening) {
        const closed = Promise.withResolvers<void>();
        httpServer.close(() => closed.resolve());
        await closed.promise;
      }
    },
  };
  fixtures.add(target);
  return target;
}

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  const watchdog = Promise.withResolvers<never>();
  const timeout = setTimeout(() => watchdog.reject(new Error(message)), FRAME_TIMEOUT_MS);
  try {
    return await Promise.race([promise, watchdog.promise]);
  } finally {
    clearTimeout(timeout);
  }
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 2; turn += 1) {
    const immediate = Promise.withResolvers<void>();
    setImmediate(immediate.resolve);
    await immediate.promise;
  }
}

function pushId(value: number): string {
  return `019a33b0-4200-7000-8000-${value.toString(16).padStart(12, "0")}`;
}

function timestamp(offsetMs: number): string {
  return new Date(BASE_TIME + offsetMs).toISOString();
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parsePush(value: unknown): PushDTO {
  const parsed = PushDTO.safeParse(value);
  if (!parsed.success) throw new Error("Received an invalid push DTO");
  return parsed.data;
}

function addPush(
  target: Fixture,
  id: string,
  createdAt: string,
  targetDeviceId: string | null = null,
): PushDTO {
  const record = PushRecord.parse({
    v: 1,
    id,
    createdAt,
    sourceDeviceId: target.owner.device.id,
    targetDeviceId,
    envelope: ENVELOPE,
    file: null,
  });
  expect(target.pushes.add(record), "Failed to seed push index").toBe(true);
  return parsePush(record);
}

function hello(token: string, since: string | null = null) {
  return { type: "hello", token, since, client: HELLO_CLIENT };
}

async function authenticate(
  client: TestClient,
  token: string,
  since: string | null = null,
): Promise<Extract<ServerFrame, { type: "ready" }>> {
  client.sendJson(hello(token, since));
  const ready = await client.nextFrame();
  expect(ready.type, "First authenticated frame was not ready").toBe("ready");
  if (ready.type !== "ready") throw new Error("First authenticated frame was not ready");
  const replayEnd = await client.nextFrame();
  expect(replayEnd.type, "Initial replay did not finish").toBe("replay_done");
  return ready;
}

async function expectClose(client: TestClient, code: number): Promise<void> {
  const closed = await withTimeout(client.closed, "Timed out waiting for WebSocket close");
  expect(closed.code, "Unexpected WebSocket close code").toBe(code);
}

function authorization(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

function jsonRequest(token: string, method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { ...authorization(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function listedDevice(target: Fixture, token: string, id: string) {
  const response = await target.request("/api/devices", { headers: authorization(token) });
  expect(response.status, "Device listing request failed").toBe(200);
  return ListDevicesResponse.parse(await response.json()).devices.find(
    (device) => device.id === id,
  );
}

describe("WebSocket authentication and replay", () => {
  test("closes an unauthenticated socket after ten seconds", async () => {
    const target = await fixture();
    const client = await target.connect();

    target.timers.advance(9_999);
    await settle();
    expect(client.socket.readyState, "Socket closed before the hello deadline").toBe(
      WebSocket.OPEN,
    );
    target.timers.advance(1);

    await expectClose(client, 4401);
  });

  test("keeps an on-time hello connected while authentication exceeds ten seconds", async () => {
    const target = await fixture();
    const client = await target.connect();
    const originalAuthenticate = target.devices.authenticate.bind(target.devices);
    const authStarted = Promise.withResolvers<void>();
    const releaseAuth = Promise.withResolvers<void>();
    vi.spyOn(target.devices, "authenticate").mockImplementationOnce(async (token) => {
      authStarted.resolve();
      await releaseAuth.promise;
      return originalAuthenticate(token);
    });
    client.sendJson(hello(target.owner.token));
    await withTimeout(authStarted.promise, "Authentication did not start");

    target.timers.advance(10_001);
    await settle();
    expect(client.socket.readyState, "Slow authentication closed an on-time hello").toBe(
      WebSocket.OPEN,
    );
    expect(client.pendingFrames, "Pending authentication sent a server frame").toBe(0);
    releaseAuth.resolve();

    expect(await client.nextFrame()).toEqual({
      type: "ready",
      deviceId: target.owner.device.id,
      serverTime: timestamp(10_001),
    });
    expect(await client.nextFrame()).toEqual({ type: "replay_done" });
  });

  test("rejects bad and revoked credentials without sending ready", async () => {
    const target = await fixture();
    const bad = await target.connect();
    const invalidToken = Buffer.alloc(32, 91).toString("base64url");
    bad.sendJson(hello(invalidToken));
    await expectClose(bad, 4401);
    expect(bad.pendingFrames, "Unauthorized socket received a frame").toBe(0);
    expect(
      target.lines.join("").includes(invalidToken),
      "Logs contained an invalid credential",
    ).toBe(false);

    const revokedDevice = await target.devices.create({ name: "Revoked", platform: "cli" });
    expect(await target.devices.remove(revokedDevice.device.id), "Device revocation failed").toBe(
      true,
    );
    const revoked = await target.connect();
    revoked.sendJson(hello(revokedDevice.token));
    await expectClose(revoked, 4401);
    expect(revoked.pendingFrames, "Revoked socket received a frame").toBe(0);
    expect(
      target.lines.join("").includes(revokedDevice.token),
      "Logs contained a revoked credential",
    ).toBe(false);
  });

  test("sends only ready and replay_done for a null cursor despite populated history", async () => {
    const target = await fixture();
    addPush(target, pushId(90), timestamp(0));
    addPush(target, pushId(91), timestamp(1));
    const client = await target.connect();

    const ready = await authenticate(client, target.owner.token);

    expect(ready, "Ready frame did not use the authenticated session").toEqual({
      type: "ready",
      deviceId: target.owner.device.id,
      serverTime: timestamp(0),
    });
    await settle();
    expect(client.pendingFrames, "Null cursor replay sent an unexpected push").toBe(0);
  });

  test("replays newer pushes oldest first across equal timestamp and id ordering", async () => {
    const target = await fixture();
    addPush(target, pushId(99), timestamp(10));
    const cursor = addPush(target, pushId(100), timestamp(10));
    const first = addPush(target, pushId(101), timestamp(10));
    const second = addPush(target, pushId(102), timestamp(10));
    const third = addPush(target, pushId(103), timestamp(11));
    const client = await target.connect();

    client.sendJson(hello(target.owner.token, cursor.id));
    expect((await client.nextFrame()).type, "Replay did not start with ready").toBe("ready");
    const replayed = [await client.nextFrame(), await client.nextFrame(), await client.nextFrame()];
    expect(
      sameJson(replayed, [
        { type: "push", push: first },
        { type: "push", push: second },
        { type: "push", push: third },
      ]),
      "Replay order was incorrect",
    ).toBe(true);
    expect((await client.nextFrame()).type, "Replay terminator was missing").toBe("replay_done");
    expect(client.pendingFrames, "Replay included a push at or before the cursor").toBe(0);
  });

  test("replays exactly two hundred newer pushes", async () => {
    const target = await fixture();
    const cursor = addPush(target, pushId(1_000), timestamp(0));
    const expected: PushDTO[] = [];
    for (let index = 1; index <= 200; index += 1) {
      expected.push(addPush(target, pushId(1_000 + index), timestamp(index)));
    }
    const client = await target.connect();

    client.sendJson(hello(target.owner.token, cursor.id));
    expect((await client.nextFrame()).type, "Replay did not start with ready").toBe("ready");
    const replayed: PushDTO[] = [];
    for (let index = 0; index < 200; index += 1) {
      const frame = await client.nextFrame();
      expect(frame.type, "Replay contained a non-push frame").toBe("push");
      if (frame.type === "push") replayed.push(frame.push);
    }
    expect(sameJson(replayed, expected), "Two-hundred item replay order was incorrect").toBe(true);
    expect((await client.nextFrame()).type, "Boundary replay did not complete").toBe("replay_done");
  });

  test("sends resync, without replay_done, for an unknown cursor or 201 newer pushes", async () => {
    const unknownTarget = await fixture();
    const unknownClient = await unknownTarget.connect();
    unknownClient.sendJson(hello(unknownTarget.owner.token, pushId(8_000)));
    expect((await unknownClient.nextFrame()).type, "Unknown cursor did not receive ready").toBe(
      "ready",
    );
    expect((await unknownClient.nextFrame()).type, "Unknown cursor did not resync").toBe("resync");
    await settle();
    expect(unknownClient.pendingFrames, "Unknown cursor received replay_done").toBe(0);

    const overflowTarget = await fixture();
    const cursor = addPush(overflowTarget, pushId(2_000), timestamp(0));
    for (let index = 1; index <= 201; index += 1) {
      addPush(overflowTarget, pushId(2_000 + index), timestamp(index));
    }
    const overflowClient = await overflowTarget.connect();
    overflowClient.sendJson(hello(overflowTarget.owner.token, cursor.id));
    expect((await overflowClient.nextFrame()).type, "Overflow replay did not receive ready").toBe(
      "ready",
    );
    expect((await overflowClient.nextFrame()).type, "Overflow replay did not resync").toBe(
      "resync",
    );
    await settle();
    expect(overflowClient.pendingFrames, "Overflow replay received replay_done").toBe(0);
  });
});

describe("WebSocket live events and presence", () => {
  test("broadcasts route events to every authenticated socket and excludes unauthenticated sockets", async () => {
    const target = await fixture();
    const other = await target.devices.create({ name: "Other", platform: "android" });
    const ownerOne = await target.connect();
    const ownerTwo = await target.connect();
    const otherClient = await target.connect();
    const unauthenticated = await target.connect();
    await authenticate(ownerOne, target.owner.token);
    await authenticate(ownerTwo, target.owner.token);
    await authenticate(otherClient, other.token);
    const authenticated = [ownerOne, ownerTwo, otherClient];

    const added = await target.devices.create({ name: "New CLI", platform: "cli" });
    for (const client of authenticated) {
      expect(await client.nextFrame(), "Device addition was not broadcast").toEqual({
        type: "device_added",
        device: added.device,
      });
    }

    const renameResponse = await target.request(
      `/api/devices/${added.device.id}`,
      jsonRequest(target.owner.token, "PATCH", { name: "Renamed CLI" }),
    );
    expect(renameResponse.status, "Device rename route failed").toBe(200);
    const renamed = await renameResponse.json();
    for (const client of authenticated) {
      expect(await client.nextFrame(), "Device update was not broadcast").toEqual({
        type: "device_updated",
        device: renamed,
      });
    }

    const requestBody = {
      id: pushId(9_000),
      targetDeviceId: other.device.id,
      envelope: ENVELOPE,
      file: null,
    };
    const createResponse = await target.request(
      "/api/pushes",
      jsonRequest(target.owner.token, "POST", requestBody),
    );
    expect(createResponse.status, "Push creation route failed").toBe(201);
    const push = parsePush(await createResponse.json());
    for (const client of authenticated) {
      expect(
        sameJson(await client.nextFrame(), { type: "push", push }),
        "Targeted push was not broadcast to every session",
      ).toBe(true);
    }

    const deleteResponse = await target.request(`/api/pushes/${push.id}`, {
      method: "DELETE",
      headers: authorization(target.owner.token),
    });
    expect(deleteResponse.status, "Push deletion route failed").toBe(204);
    for (const client of authenticated) {
      expect(await client.nextFrame(), "Push deletion was not broadcast").toEqual({
        type: "push_deleted",
        id: push.id,
      });
    }

    await settle();
    expect(unauthenticated.pendingFrames, "Unauthenticated socket received a live event").toBe(0);
    const logText = target.lines.join("");
    expect(
      [target.owner.token, other.token, ENVELOPE.n, ENVELOPE.c].some((secret) =>
        logText.includes(secret),
      ),
      "Logs contained a credential or encrypted payload",
    ).toBe(false);
  });

  test("broadcasts device removal before closing every socket for that device", async () => {
    const target = await fixture();
    const removedDevice = await target.devices.create({ name: "Removed", platform: "web" });
    const observer = await target.connect();
    const removedOne = await target.connect();
    const removedTwo = await target.connect();
    await authenticate(observer, target.owner.token);
    await authenticate(removedOne, removedDevice.token);
    await authenticate(removedTwo, removedDevice.token);

    const response = await target.request(`/api/devices/${removedDevice.device.id}`, {
      method: "DELETE",
      headers: authorization(target.owner.token),
    });
    expect(response.status, "Device deletion route failed").toBe(204);
    const expected = { type: "device_removed", id: removedDevice.device.id };
    expect(await observer.nextFrame(), "Observer missed device removal").toEqual(expected);
    expect(await removedOne.nextFrame(), "First revoked session missed device removal").toEqual(
      expected,
    );
    expect(await removedTwo.nextFrame(), "Second revoked session missed device removal").toEqual(
      expected,
    );
    await Promise.all([expectClose(removedOne, 4401), expectClose(removedTwo, 4401)]);
    expect(observer.socket.readyState, "Unrelated device socket was closed").toBe(WebSocket.OPEN);
  });

  test("debounces online transitions and keeps a device online until its final socket closes", async () => {
    const target = await fixture(1_000);
    const secondDevice = await target.devices.create({ name: "Second", platform: "android" });
    const observer = await target.connect();
    const secondOne = await target.connect();
    const secondTwo = await target.connect();
    await authenticate(observer, target.owner.token);
    await authenticate(secondOne, secondDevice.token);
    await authenticate(secondTwo, secondDevice.token);

    expect(
      (await listedDevice(target, target.owner.token, target.owner.device.id))?.online,
      "Owner was not immediately online in HTTP DTOs",
    ).toBe(true);
    expect(
      (await listedDevice(target, target.owner.token, secondDevice.device.id))?.online,
      "Second device was not immediately online in HTTP DTOs",
    ).toBe(true);
    target.timers.advance(1_999);
    await settle();
    expect(observer.pendingFrames, "Online update was emitted before debounce elapsed").toBe(0);
    target.timers.advance(1);
    const onlineUpdates = [await observer.nextFrame(), await observer.nextFrame()];
    expect(
      onlineUpdates.map((frame) =>
        frame.type === "device_updated" ? [frame.device.id, frame.device.online] : [frame.type],
      ),
      "Debounced online updates were incorrect",
    ).toEqual([
      [target.owner.device.id, true],
      [secondDevice.device.id, true],
    ]);

    secondOne.socket.close(1000);
    await expectClose(secondOne, 1000);
    target.timers.advance(2_000);
    await settle();
    expect(
      (await listedDevice(target, target.owner.token, secondDevice.device.id))?.online,
      "Device went offline while another socket remained",
    ).toBe(true);
    expect(observer.pendingFrames, "Closing a non-final socket emitted an online update").toBe(0);

    secondTwo.socket.close(1000);
    await expectClose(secondTwo, 1000);
    expect(
      (await listedDevice(target, target.owner.token, secondDevice.device.id))?.online,
      "Final disconnect was not immediately visible in HTTP DTOs",
    ).toBe(false);
    target.timers.advance(1_999);
    await settle();
    expect(observer.pendingFrames, "Offline update was emitted before debounce elapsed").toBe(0);
    target.timers.advance(1);
    const offline = await observer.nextFrame();
    expect(offline, "Final disconnect did not broadcast offline status").toEqual({
      type: "device_updated",
      device: { ...secondDevice.device, online: false },
    });
  });
});

describe("WebSocket heartbeat, shutdown, and resource limits", () => {
  test("terminates after two full missed pong windows", async () => {
    const target = await fixture(5);
    const client = await target.connect();
    await authenticate(client, target.owner.token);

    target.timers.advance(2_000);
    expect((await client.nextFrame()).type).toBe("device_updated");
    target.timers.advance(3_000);
    expect((await client.nextFrame()).type, "First heartbeat ping was missing").toBe("ping");
    target.timers.advance(5_000);
    expect((await client.nextFrame()).type, "Second heartbeat ping was missing").toBe("ping");
    expect(client.socket.readyState, "Socket closed before two response windows elapsed").toBe(
      WebSocket.OPEN,
    );
    target.timers.advance(5_000);

    await expectClose(client, 1006);
  });

  test("pong resets heartbeat liveness", async () => {
    const target = await fixture(5);
    const client = await target.connect();
    await authenticate(client, target.owner.token);

    target.timers.advance(2_000);
    expect((await client.nextFrame()).type).toBe("device_updated");
    target.timers.advance(3_000);
    expect((await client.nextFrame()).type, "First heartbeat ping was missing").toBe("ping");
    client.sendJson({ type: "pong" });
    await settle();
    target.timers.advance(5_000);
    expect((await client.nextFrame()).type, "Second heartbeat ping was missing").toBe("ping");
    client.sendJson({ type: "pong" });
    await settle();
    target.timers.advance(5_000);
    expect((await client.nextFrame()).type, "Third heartbeat ping was missing").toBe("ping");
    expect(client.socket.readyState, "Live socket was terminated").toBe(WebSocket.OPEN);
  });

  test("shutdown closes authenticated and unauthenticated sockets with 1012 and cancels timers", async () => {
    const target = await fixture();
    const authenticated = await target.connect();
    const unauthenticated = await target.connect();
    await authenticate(authenticated, target.owner.token);

    await target.stopHub();
    await Promise.all([expectClose(authenticated, 1012), expectClose(unauthenticated, 1012)]);
    expect(target.timers.pendingCount, "Shutdown left WebSocket timers active").toBe(0);
    expect(
      target.devices.get(target.owner.device.id)?.online,
      "Shutdown left authenticated device online",
    ).toBe(false);
  });

  test("terminates a socket whose buffered output exceeds one MiB", async () => {
    const target = await fixture();
    const client = await target.connect();
    await authenticate(client, target.owner.token);
    vi.spyOn(WebSocket.prototype, "bufferedAmount", "get").mockReturnValue(1_048_577);

    target.events.emit("push_deleted", { id: pushId(9_999) });

    await expectClose(client, 1006);
  });
});

describe("WebSocket protocol errors", () => {
  test.each(["whole", "fragmented"] as const)(
    "closes an oversized %s message with 1009 before hello",
    async (delivery) => {
      const target = await fixture();
      const client = await target.connect();
      const payload = "x".repeat(65_537);
      if (delivery === "fragmented") {
        client.socket.send(payload.slice(0, 32_768), { fin: false });
        client.socket.send(payload.slice(32_768), { fin: true });
      } else {
        client.socket.send(payload);
      }

      await expectClose(client, 1009);
      expect(client.pendingFrames, "Oversized unauthenticated message received a frame").toBe(0);
    },
  );

  test("closes malformed JSON, binary, invalid-schema, unknown, and pre-hello pong frames with 4400", async () => {
    const target = await fixture();
    const cases: Array<(client: TestClient) => void> = [
      (client) => client.socket.send("{not-json"),
      (client) => client.socket.send(Buffer.from("binary"), { binary: true }),
      (client) => client.sendJson({ type: "hello", token: target.owner.token, since: null }),
      (client) => client.sendJson({ type: "unknown" }),
      (client) => client.sendJson({ type: "pong" }),
    ];

    for (const send of cases) {
      const client = await target.connect();
      send(client);
      await expectClose(client, 4400);
      expect(client.pendingFrames, "Protocol-error socket received a server frame").toBe(0);
    }
  });

  test("accepts only the first hello frame", async () => {
    const target = await fixture();
    const client = await target.connect();
    await authenticate(client, target.owner.token);

    client.sendJson(hello(target.owner.token));

    await expectClose(client, 4400);
  });

  test("does not authenticate a disconnected socket or a credential revoked during pending auth", async () => {
    const disconnectedTarget = await fixture();
    const disconnected = await disconnectedTarget.connect();
    const authStarted = Promise.withResolvers<void>();
    const releaseAuth = Promise.withResolvers<void>();
    const authenticatedDevice = disconnectedTarget.owner.device;
    vi.spyOn(disconnectedTarget.devices, "authenticate").mockImplementationOnce(async () => {
      authStarted.resolve();
      await releaseAuth.promise;
      return authenticatedDevice;
    });
    disconnected.sendJson(hello(disconnectedTarget.owner.token));
    await withTimeout(authStarted.promise, "Authentication did not start");
    disconnected.terminate();
    await expectClose(disconnected, 1006);
    releaseAuth.resolve();
    await settle();
    expect(
      disconnectedTarget.devices.get(authenticatedDevice.id)?.online,
      "Disconnected pending authentication changed presence",
    ).toBe(false);
    vi.restoreAllMocks();

    const revokedTarget = await fixture();
    const revoked = await revokedTarget.connect();
    const originalAuthenticate = revokedTarget.devices.authenticate.bind(revokedTarget.devices);
    const revokedAuthStarted = Promise.withResolvers<void>();
    const releaseRevokedAuth = Promise.withResolvers<void>();
    vi.spyOn(revokedTarget.devices, "authenticate").mockImplementationOnce(async (token) => {
      revokedAuthStarted.resolve();
      await releaseRevokedAuth.promise;
      return originalAuthenticate(token);
    });
    revoked.sendJson(hello(revokedTarget.owner.token));
    await withTimeout(revokedAuthStarted.promise, "Authentication did not start");
    expect(
      await revokedTarget.devices.remove(revokedTarget.owner.device.id),
      "Pending credential revocation failed",
    ).toBe(true);
    releaseRevokedAuth.resolve();

    await expectClose(revoked, 4401);
    expect(revoked.pendingFrames, "Revoked pending authentication received ready").toBe(0);
  });
});
