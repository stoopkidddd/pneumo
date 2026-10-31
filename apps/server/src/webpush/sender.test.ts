import { Writable } from "node:stream";
import {
  type CreatePushRequest,
  type DeviceRecord,
  type Platform,
  type PushDTO,
  type PushRecord,
  uuidv7,
  type WebPushSubscription,
} from "@pneumo/protocol";
import type { Logger } from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";
import webPush, { type SendResult } from "web-push";
import { type Clock, createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { DeviceRegistry } from "../devices/registry.js";
import { EventBus } from "../events.js";
import { FileRegistry } from "../files/registry.js";
import { PushIndex, pushObjectKey } from "../index-store/index.js";
import { InstanceState } from "../instance/state.js";
import { createLogger } from "../log.js";
import { MemoryStorage } from "../storage/memory.js";
import { startWebPushSender } from "./sender.js";
import type { VapidKeys } from "./vapid.js";

const START = Date.parse("2026-10-01T00:00:00.000Z");
const PERSISTED_SUBJECT = "mailto:persisted@example.test";
const generatedVapidKeys = webPush.generateVAPIDKeys();
const vapidKeys: VapidKeys = {
  ...generatedVapidKeys,
  subject: PERSISTED_SUBJECT,
};
const envelope = {
  v: 1 as const,
  n: Buffer.alloc(12, 1).toString("base64url"),
  c: Buffer.alloc(16, 2).toString("base64url"),
};
const successfulSend: SendResult = { statusCode: 201, body: "", headers: {} };

type TimerTask = {
  at: number;
  callback: () => void;
  active: boolean;
};

class FakeTimers {
  private readonly tasks = new Set<TimerTask>();

  constructor(private readonly now: () => number) {}

  readonly after = (ms: number, callback: () => void): (() => void) => {
    const task = { at: this.now() + ms, callback, active: true };
    this.tasks.add(task);
    return () => {
      task.active = false;
      this.tasks.delete(task);
    };
  };

  runDue(): void {
    for (;;) {
      const due = [...this.tasks]
        .filter((task) => task.active && task.at <= this.now())
        .sort((left, right) => left.at - right.at)[0];
      if (due === undefined) return;
      due.active = false;
      this.tasks.delete(due);
      due.callback();
    }
  }

  get size(): number {
    return [...this.tasks].filter((task) => task.active).length;
  }
}

async function flushMicrotasks(turns = 30): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}

function makeSubscription(label: string, fill = 3): WebPushSubscription {
  return {
    endpoint: `https://push.example.test/${label}`,
    keys: {
      p256dh: Buffer.alloc(65, fill).toString("base64url"),
      auth: Buffer.alloc(16, fill + 1).toString("base64url"),
    },
  };
}

function makePush(
  sourceDeviceId: string,
  targetDeviceId: string | null = null,
  overrides: Partial<PushDTO> = {},
): PushDTO {
  return {
    id: uuidv7(),
    createdAt: new Date(START).toISOString(),
    sourceDeviceId,
    targetDeviceId,
    envelope,
    file: null,
    ...overrides,
  };
}

function makePushWithPayloadBytes(
  sourceDeviceId: string,
  targetDeviceId: string,
  bytes: number,
): PushDTO {
  const push = makePush(sourceDeviceId, targetDeviceId, {
    envelope: { ...envelope, c: "" },
  });
  const emptySize = Buffer.byteLength(JSON.stringify({ t: "push", push }));
  const ciphertextSize = bytes - emptySize;
  if (ciphertextSize < 22) throw new Error("Requested payload is too small");
  push.envelope.c = "A".repeat(ciphertextSize);
  if (Buffer.byteLength(JSON.stringify({ t: "push", push })) !== bytes) {
    throw new Error("Unable to construct requested payload size");
  }
  return push;
}

function payloadFromCall(call: readonly unknown[]): { t: string; push?: PushDTO; id?: string } {
  const payload = call[1];
  if (typeof payload !== "string") throw new Error("Expected a string Web Push payload");
  return JSON.parse(payload) as { t: string; push?: PushDTO; id?: string };
}

function warningLines(lines: readonly string[]): Record<string, unknown>[] {
  return lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.level === 40);
}

async function fixture(subject = "mailto:configured@example.test") {
  let now = START;
  const clock: Clock = { now: () => now };
  const timers = new FakeTimers(clock.now);
  const storage = new MemoryStorage({ now: clock.now });
  const lines: string[] = [];
  const logger: Logger = createLogger(
    "info",
    new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    }),
  );
  const config = loadConfig({
    PUBLIC_URL: "https://pneumo.example",
    S3_ENDPOINT: "https://objects.example",
    S3_BUCKET: "test-bucket",
    S3_ACCESS_KEY_ID: "fake-access-key",
    S3_SECRET_ACCESS_KEY: "fake-secret-key",
    PNEUMO_SETUP_TOKEN: "fixed-test-setup",
    VAPID_SUBJECT: subject,
  });
  const events = new EventBus();
  const devices = await DeviceRegistry.load({ storage, clock, events });
  const pushes = await PushIndex.load({ storage, events });
  const instanceState = await InstanceState.load({ storage, clock, config, logger });
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
    vapidPublicKey: vapidKeys.publicKey,
  });

  async function addDevice(
    name: string,
    platform: Platform,
    subscription: WebPushSubscription | null = makeSubscription(name),
  ) {
    const created = await devices.create({ name, platform });
    if (subscription !== null) await devices.setWebPush(created.device.id, subscription);
    return { ...created, subscription };
  }

  return {
    app,
    storage,
    clock,
    timers,
    config,
    events,
    devices,
    pushes,
    lines,
    addDevice,
    advance(ms: number) {
      now += ms;
      timers.runDue();
    },
    start() {
      return startWebPushSender({
        devices,
        events,
        config,
        vapidKeys,
        clock,
        logger,
        timers,
      });
    },
  };
}

function requestBody(targetDeviceId: string | null = null): CreatePushRequest {
  return { id: uuidv7(), targetDeviceId, envelope, file: null };
}

function json(body: unknown, token: string): RequestInit {
  return {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

function deliveryError(statusCode: number, endpoint: string): Error {
  return new webPush.WebPushError(
    `private-error-message-${statusCode}`,
    statusCode,
    {},
    `private-response-body-${statusCode}`,
    endpoint,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Web Push sender", () => {
  test("excludes the source and sends only to eligible targeted or broadcast web devices", async () => {
    const send = vi.spyOn(webPush, "sendNotification").mockResolvedValue(successfulSend);
    const target = await fixture();
    const source = await target.addDevice("source", "web", makeSubscription("source", 1));
    const selected = await target.addDevice("selected", "web", makeSubscription("selected", 2));
    const other = await target.addDevice("other", "web", makeSubscription("other", 3));
    await target.addDevice("unsubscribed", "web", null);
    const android = await target.addDevice("android", "android", makeSubscription("android", 4));
    const cli = await target.addDevice("cli", "cli", makeSubscription("cli", 5));
    const stop = target.start();

    target.events.emit("push", {
      push: makePush(source.device.id, selected.device.id),
    });
    target.events.emit("push", {
      push: makePush(source.device.id, source.device.id),
    });
    target.events.emit("push", { push: makePush(source.device.id) });
    expect(send).not.toHaveBeenCalled();
    await flushMicrotasks();

    expect(send).toHaveBeenCalledTimes(3);
    const endpoints = send.mock.calls.map((call) => call[0].endpoint);
    expect(
      endpoints.filter((endpoint) => endpoint === selected.subscription?.endpoint).length,
    ).toBe(2);
    expect(endpoints.filter((endpoint) => endpoint === other.subscription?.endpoint).length).toBe(
      1,
    );
    expect(endpoints.some((endpoint) => endpoint === source.subscription?.endpoint)).toBe(false);
    expect(endpoints.some((endpoint) => endpoint === android.subscription?.endpoint)).toBe(false);
    expect(endpoints.some((endpoint) => endpoint === cli.subscription?.endpoint)).toBe(false);
    stop();
  });

  test("uses the full payload through 3000 bytes, a reference at 3001, and send-time config", async () => {
    const send = vi.spyOn(webPush, "sendNotification").mockResolvedValue(successfulSend);
    const target = await fixture("mailto:startup@example.test");
    const source = await target.addDevice("source", "cli", null);
    const receiver = await target.addDevice("receiver", "web", makeSubscription("payload", 6));
    const stop = target.start();
    const sendTimeSubject = "mailto:send-time@example.test";
    target.config.VAPID_SUBJECT = sendTimeSubject;
    const exact = makePushWithPayloadBytes(source.device.id, receiver.device.id, 3000);
    const large = makePushWithPayloadBytes(source.device.id, receiver.device.id, 3001);
    expect(Buffer.byteLength(JSON.stringify({ t: "push", push: large }))).toBe(3001);

    target.events.emit("push", { push: exact });
    target.events.emit("push", { push: large });
    await flushMicrotasks();

    expect(send).toHaveBeenCalledTimes(2);
    const first = send.mock.calls[0];
    const second = send.mock.calls[1];
    if (first === undefined || second === undefined) throw new Error("Missing Web Push calls");
    expect(Buffer.byteLength(String(first[1]))).toBe(3000);
    expect(payloadFromCall(first)).toEqual({ t: "push", push: exact });
    expect(payloadFromCall(second)).toEqual({ t: "ref", id: large.id });
    const options = first[2];
    expect(options?.TTL).toBe(86_400);
    expect(options?.urgency).toBe("high");
    expect(options?.timeout).toBe(10_000);
    expect(options?.vapidDetails?.subject === sendTimeSubject).toBe(true);
    expect(options?.vapidDetails?.subject === vapidKeys.subject).toBe(false);
    expect(options?.vapidDetails?.publicKey === vapidKeys.publicKey).toBe(true);
    expect(options?.vapidDetails?.privateKey === vapidKeys.privateKey).toBe(true);
    stop();
  });

  test("clears persisted subscriptions for 404 and 410 but retains them for 500", async () => {
    const target = await fixture();
    const source = await target.addDevice("source", "cli", null);
    const gone404 = await target.addDevice("gone404", "web", makeSubscription("gone404", 7));
    const gone410 = await target.addDevice("gone410", "web", makeSubscription("gone410", 8));
    const retryable = await target.addDevice("retryable", "web", makeSubscription("retryable", 9));
    vi.spyOn(webPush, "sendNotification").mockImplementation((subscription) => {
      const status =
        subscription.endpoint === gone404.subscription?.endpoint
          ? 404
          : subscription.endpoint === gone410.subscription?.endpoint
            ? 410
            : 500;
      return Promise.reject(deliveryError(status, subscription.endpoint));
    });
    const stop = target.start();

    target.events.emit("push", { push: makePush(source.device.id, gone404.device.id) });
    target.events.emit("push", { push: makePush(source.device.id, gone410.device.id) });
    target.events.emit("push", { push: makePush(source.device.id, retryable.device.id) });
    await flushMicrotasks(50);

    const record404 = await target.storage.getJson<DeviceRecord>(
      `devices/${gone404.device.id}.json`,
    );
    const record410 = await target.storage.getJson<DeviceRecord>(
      `devices/${gone410.device.id}.json`,
    );
    const record500 = await target.storage.getJson<DeviceRecord>(
      `devices/${retryable.device.id}.json`,
    );
    expect(record404.webPush === null).toBe(true);
    expect(record410.webPush === null).toBe(true);
    expect(record500.webPush !== null).toBe(true);
    stop();
  });

  test("deduplicates direct and reconciled events for ten minutes and allows the boundary", async () => {
    const send = vi.spyOn(webPush, "sendNotification").mockResolvedValue(successfulSend);
    const target = await fixture();
    const source = await target.addDevice("source", "cli", null);
    const receiver = await target.addDevice("receiver", "web", makeSubscription("dedupe", 10));
    const stop = target.start();
    const push = makePush(source.device.id, receiver.device.id);

    target.events.emit("push", { push });
    await flushMicrotasks();
    expect(send).toHaveBeenCalledTimes(1);

    const record: PushRecord = { v: 1, ...push };
    await target.storage.putJson(pushObjectKey(record), record);
    await target.pushes.reconcile();
    target.events.emit("push", { push });
    target.advance(599_999);
    target.events.emit("push", { push });
    await flushMicrotasks();
    expect(send).toHaveBeenCalledTimes(1);

    target.advance(1);
    target.events.emit("push", { push });
    await flushMicrotasks();
    expect(send).toHaveBeenCalledTimes(2);
    stop();
  });

  test("bounds the waiting queue at 1000, drops its oldest entries, and runs four sends", async () => {
    const sends: PromiseWithResolvers<SendResult>[] = [];
    const send = vi.spyOn(webPush, "sendNotification").mockImplementation(() => {
      const pending = Promise.withResolvers<SendResult>();
      sends.push(pending);
      return pending.promise;
    });
    const target = await fixture();
    const source = await target.addDevice("source", "cli", null);
    const receiver = await target.addDevice("receiver", "web", makeSubscription("bounded", 11));
    const stop = target.start();
    const pushes = Array.from({ length: 1005 }, () =>
      makePush(source.device.id, receiver.device.id),
    );

    for (const push of pushes.slice(0, 4)) target.events.emit("push", { push });
    expect(send).not.toHaveBeenCalled();
    await flushMicrotasks();
    expect(send).toHaveBeenCalledTimes(4);

    for (const push of pushes.slice(4)) target.events.emit("push", { push });
    await flushMicrotasks();
    expect(send).toHaveBeenCalledTimes(4);
    expect(warningLines(target.lines).length).toBeGreaterThanOrEqual(1);

    for (const pending of sends.slice(0, 4)) pending.resolve(successfulSend);
    await flushMicrotasks();
    expect(send).toHaveBeenCalledTimes(8);
    expect(send.mock.calls.slice(4).map((call) => payloadFromCall(call).push?.id)).toEqual(
      pushes.slice(5, 9).map((push) => push.id),
    );
    expect(sends).toHaveLength(8);
    stop();
  });

  test("hard timeouts release concurrency slots and safely observe late rejection", async () => {
    const sends: PromiseWithResolvers<SendResult>[] = [];
    const send = vi.spyOn(webPush, "sendNotification").mockImplementation(() => {
      const pending = Promise.withResolvers<SendResult>();
      sends.push(pending);
      return pending.promise;
    });
    const target = await fixture();
    const source = await target.addDevice("source", "cli", null);
    const receiver = await target.addDevice("receiver", "web", makeSubscription("timeout", 12));
    const stop = target.start();
    for (let index = 0; index < 5; index += 1) {
      target.events.emit("push", { push: makePush(source.device.id, receiver.device.id) });
    }
    await flushMicrotasks();
    expect(send).toHaveBeenCalledTimes(4);
    expect(target.timers.size).toBe(4);

    target.advance(9_999);
    await flushMicrotasks();
    expect(send).toHaveBeenCalledTimes(4);
    target.advance(1);
    await flushMicrotasks();
    expect(send).toHaveBeenCalledTimes(5);

    for (const pending of sends.slice(0, 4)) {
      pending.reject(new Error("private-late-rejection"));
    }
    await flushMicrotasks();
    expect(warningLines(target.lines).length).toBeGreaterThanOrEqual(4);
    expect(target.lines.join("").includes("private-late-rejection")).toBe(false);
    stop();
  });

  test("shutdown synchronously cancels timers, queued work, and the event subscription", async () => {
    const sends: PromiseWithResolvers<SendResult>[] = [];
    const send = vi.spyOn(webPush, "sendNotification").mockImplementation(() => {
      const pending = Promise.withResolvers<SendResult>();
      sends.push(pending);
      return pending.promise;
    });
    const target = await fixture();
    const source = await target.addDevice("source", "cli", null);
    const receiver = await target.addDevice("receiver", "web", makeSubscription("shutdown", 13));
    const stop = target.start();

    for (let index = 0; index < 7; index += 1) {
      target.events.emit("push", { push: makePush(source.device.id, receiver.device.id) });
    }
    await flushMicrotasks();
    expect(send).toHaveBeenCalledTimes(4);
    expect(target.timers.size).toBe(4);

    stop();
    expect(target.timers.size).toBe(0);
    for (const pending of sends) pending.resolve(successfulSend);
    target.events.emit("push", { push: makePush(source.device.id, receiver.device.id) });
    await flushMicrotasks();
    expect(send).toHaveBeenCalledTimes(4);
  });

  test.each(["http://insecure-subject.example.test", "not-a-vapid-subject"])(
    "an invalid VAPID subject cannot crash startup or a push request: %s",
    async (subject) => {
      const send = vi.spyOn(webPush, "sendNotification").mockResolvedValue(successfulSend);
      const target = await fixture(subject);
      const owner = await target.addDevice("owner", "cli", null);
      await target.addDevice("receiver", "web", makeSubscription("invalid-subject", 14));
      let stop: () => void = () => undefined;
      expect(() => {
        stop = target.start();
      }).not.toThrow();

      const response = await target.app.request("/api/pushes", json(requestBody(), owner.token));
      expect(response.status).toBe(201);
      await flushMicrotasks();
      expect(send).not.toHaveBeenCalled();
      expect(warningLines(target.lines).length).toBeGreaterThanOrEqual(1);
      expect(target.lines.join("").includes(subject)).toBe(false);
      stop();
    },
  );

  test("push requests return immediately while delivery hangs and unauthorized requests do not send", async () => {
    const send = vi
      .spyOn(webPush, "sendNotification")
      .mockImplementation(() => Promise.withResolvers<SendResult>().promise);
    const target = await fixture();
    const owner = await target.addDevice("owner", "cli", null);
    await target.addDevice("receiver", "web", makeSubscription("route", 15));
    const stop = target.start();

    const unauthorized = await target.app.request("/api/pushes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody()),
    });
    expect(unauthorized.status).toBe(401);
    await flushMicrotasks();
    expect(send).not.toHaveBeenCalled();

    const response = await target.app.request("/api/pushes", json(requestBody(), owner.token));
    expect(response.status).toBe(201);
    await flushMicrotasks();
    expect(send).toHaveBeenCalledTimes(1);
    stop();
  });

  test("failure warnings expose safe context without errors, response bodies, or credentials", async () => {
    const errorMessage = "sender-error-message-secret";
    const responseBody = "sender-response-body-secret";
    const errorEndpoint = "https://private-error-endpoint.example.test/token";
    const target = await fixture("mailto:logging-subject-secret@example.test");
    const source = await target.addDevice("source", "cli", null);
    const subscription = makeSubscription("private-subscription-endpoint", 16);
    const receiver = await target.addDevice("receiver", "web", subscription);
    const error = Object.assign(new Error(errorMessage), {
      statusCode: 500,
      body: responseBody,
      endpoint: errorEndpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      privateKey: vapidKeys.privateKey,
    });
    vi.spyOn(webPush, "sendNotification").mockRejectedValue(error);
    const stop = target.start();

    target.events.emit("push", { push: makePush(source.device.id, receiver.device.id) });
    await flushMicrotasks();

    const serialized = target.lines.join("");
    const warnings = warningLines(target.lines);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    const failure = warnings.find((warning) => warning.deviceId === receiver.device.id);
    expect(failure?.msg).toBe("Web Push send failed");
    expect(failure?.statusCode).toBe(500);
    expect(
      [
        errorMessage,
        responseBody,
        errorEndpoint,
        subscription.endpoint,
        subscription.keys.p256dh,
        subscription.keys.auth,
        vapidKeys.privateKey,
        target.config.VAPID_SUBJECT,
      ].every((secret) => !serialized.includes(secret)),
    ).toBe(true);
    stop();
  });
});
