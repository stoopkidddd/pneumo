import { b64uEncode, deriveKeys, deriveMasterKey, keyCheck, newKdfParams } from "@pneumo/crypto";
import {
  ClaimPairResponse,
  CreatePairResponse,
  DeviceDTO,
  ErrorBody,
  ListDevicesResponse,
  LoginResponse,
  MeResponse,
  type SetupRequest,
  SetupResponse,
  type WebPushSubscription,
} from "@pneumo/protocol";
import { beforeAll, describe, expect, test } from "vitest";
import { type Clock, createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { EventBus } from "../events.js";
import { InstanceState } from "../instance/state.js";
import { createLogger } from "../log.js";
import { MemoryStorage } from "../storage/memory.js";
import { loadVapidKeys } from "../webpush/vapid.js";
import { DeviceRegistry } from "./registry.js";

const SETUP_TOKEN = "fixed-test-setup";
let setupRequest: SetupRequest;

beforeAll(async () => {
  const kdf = newKdfParams();
  const masterKey = await deriveMasterKey("correct horse battery staple", kdf);
  const { authKey } = await deriveKeys(masterKey);
  setupRequest = {
    setupToken: SETUP_TOKEN,
    kdf,
    authKey: b64uEncode(authKey),
    keyCheck: b64uEncode(await keyCheck(masterKey)),
    device: { name: "Owner browser", platform: "web" },
  };
}, 30_000);

async function initializedFixture() {
  let now = Date.parse("2026-03-01T00:00:00.000Z");
  const clock: Clock = { now: () => now };
  const config = loadConfig({
    PUBLIC_URL: "https://pneumo.example",
    S3_ENDPOINT: "https://objects.example",
    S3_BUCKET: "test-bucket",
    S3_ACCESS_KEY_ID: "fake-access-key",
    S3_SECRET_ACCESS_KEY: "fake-secret-key",
    PNEUMO_SETUP_TOKEN: SETUP_TOKEN,
    MAX_FILE_BYTES: "123456",
    MAX_ENVELOPE_BYTES: "54321",
    LOG_LEVEL: "silent",
  });
  const storage = new MemoryStorage({ now: clock.now });
  const logger = createLogger("silent");
  const instanceState = await InstanceState.load({ storage, config, clock, logger });
  const events = new EventBus();
  const devices = await DeviceRegistry.load({ storage, clock, events });
  const vapidKeys = await loadVapidKeys({ storage, config });
  const app = createApp({
    config,
    storage,
    clock,
    logger,
    instanceState,
    devices,
    uploadMode: "proxy",
    vapidPublicKey: vapidKeys.publicKey,
  });
  const setupResponse = await app.request("/api/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(setupRequest),
  });
  expect(setupResponse.status).toBe(201);
  const owner = SetupResponse.parse(await setupResponse.json());
  return {
    app,
    devices,
    events,
    instanceState,
    owner,
    storage,
    vapidKeys,
    advance(ms: number) {
      now += ms;
    },
  };
}

function authorization(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function json(method: string, body: unknown, token?: string): RequestInit {
  return {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token === undefined ? {} : authorization(token)),
    },
    body: JSON.stringify(body),
  };
}

function hasInternalDeviceFields(value: unknown): boolean {
  const serialized = JSON.stringify(value);
  return serialized.includes("tokenHash") || serialized.includes("webPush");
}

const webPush: WebPushSubscription = {
  endpoint: "https://push.example.test/delivery",
  keys: {
    p256dh: b64uEncode(new Uint8Array(65).fill(3)),
    auth: b64uEncode(new Uint8Array(16).fill(4)),
  },
};

describe("bearer-protected device routes", () => {
  test.each([
    ["GET", "/api/me"],
    ["GET", "/api/devices"],
    ["PATCH", "/api/devices/019a33b0-4200-7000-8000-000000000001"],
    ["DELETE", "/api/devices/019a33b0-4200-7000-8000-000000000001"],
    ["PUT", "/api/devices/self/webpush"],
    ["DELETE", "/api/devices/self/webpush"],
    ["POST", "/api/pair"],
  ])("%s %s rejects missing and invalid bearer credentials", async (method, path) => {
    const target = await initializedFixture();
    for (const headers of [{}, authorization(b64uEncode(new Uint8Array(32).fill(9)))]) {
      const response = await target.app.request(path, { method, headers });
      expect(response.status).toBe(401);
      expect(ErrorBody.parse(await response.json()).error.code).toBe("unauthorized");
    }
  });

  test("GET /me satisfies the full client contract without exposing stored secrets", async () => {
    const target = await initializedFixture();
    const response = await target.app.request("/api/me", {
      headers: authorization(target.owner.token),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    const parsed = MeResponse.parse(body);
    expect(parsed.vapidPublicKey).toBe(target.vapidKeys.publicKey);
    expect(JSON.stringify(body).includes(target.vapidKeys.privateKey)).toBe(false);
    expect(parsed.keyCheck === setupRequest.keyCheck).toBe(true);
    expect(parsed.limits).toEqual({ maxFileBytes: 123456, maxEnvelopeBytes: 54321 });
    expect(parsed.uploadMode).toBe("proxy");
    expect(hasInternalDeviceFields(body)).toBe(false);
  });

  test("lists and renames the caller and another device without leaking records", async () => {
    const target = await initializedFixture();
    const loginResponse = await target.app.request(
      "/api/auth/login",
      json("POST", {
        authKey: setupRequest.authKey,
        device: { name: "Command line", platform: "cli" },
      }),
    );
    const other = LoginResponse.parse(await loginResponse.json());

    const ownerRename = await target.app.request(
      `/api/devices/${target.owner.device.id}`,
      json("PATCH", { name: "Primary browser", extra: "stripped" }, target.owner.token),
    );
    expect(DeviceDTO.parse(await ownerRename.json()).name).toBe("Primary browser");
    const otherRename = await target.app.request(
      `/api/devices/${other.device.id}`,
      json("PATCH", { name: "Automation CLI" }, target.owner.token),
    );
    expect(DeviceDTO.parse(await otherRename.json()).name).toBe("Automation CLI");

    const listResponse = await target.app.request("/api/devices", {
      headers: authorization(target.owner.token),
    });
    const list = ListDevicesResponse.parse(await listResponse.json());
    expect(list.devices.map((device) => device.name).sort()).toEqual([
      "Automation CLI",
      "Primary browser",
    ]);
    expect(hasInternalDeviceFields(list)).toBe(false);
  });

  test("deleting another device and then self immediately revokes each token", async () => {
    const target = await initializedFixture();
    const otherResponse = await target.app.request(
      "/api/auth/login",
      json("POST", {
        authKey: setupRequest.authKey,
        device: { name: "Other browser", platform: "web" },
      }),
    );
    const other = LoginResponse.parse(await otherResponse.json());

    const deleteOther = await target.app.request(`/api/devices/${other.device.id}`, {
      method: "DELETE",
      headers: authorization(target.owner.token),
    });
    expect(deleteOther.status).toBe(204);
    expect(
      (await target.app.request("/api/me", { headers: authorization(other.token) })).status,
    ).toBe(401);

    const deleteSelf = await target.app.request(`/api/devices/${target.owner.device.id}`, {
      method: "DELETE",
      headers: authorization(target.owner.token),
    });
    expect(deleteSelf.status).toBe(204);
    expect(
      (await target.app.request("/api/me", { headers: authorization(target.owner.token) })).status,
    ).toBe(401);
  });

  test("stores, validates, and clears the caller's Web Push subscription", async () => {
    const target = await initializedFixture();
    const invalid = await target.app.request(
      "/api/devices/self/webpush",
      json(
        "PUT",
        { subscription: { ...webPush, keys: { ...webPush.keys, auth: "invalid" } } },
        target.owner.token,
      ),
    );
    expect(invalid.status).toBe(400);

    const stored = await target.app.request(
      "/api/devices/self/webpush",
      json("PUT", { subscription: webPush }, target.owner.token),
    );
    expect(stored.status).toBe(204);
    const record = await target.storage.getJson<Record<string, unknown>>(
      `devices/${target.owner.device.id}.json`,
    );
    expect(JSON.stringify(record.webPush) === JSON.stringify(webPush)).toBe(true);

    const cleared = await target.app.request("/api/devices/self/webpush", {
      method: "DELETE",
      headers: authorization(target.owner.token),
    });
    expect(cleared.status).toBe(204);
    const clearedRecord = await target.storage.getJson<Record<string, unknown>>(
      `devices/${target.owner.device.id}.json`,
    );
    expect(clearedRecord.webPush === null).toBe(true);
  });
});

describe("phone pairing routes", () => {
  test("claims an Android code once and returns a secret-free device DTO", async () => {
    const target = await initializedFixture();
    const create = await target.app.request("/api/pair", {
      method: "POST",
      headers: authorization(target.owner.token),
    });
    expect(create.status).toBe(201);
    const pair = CreatePairResponse.parse(await create.json());
    expect(pair.expiresAt).toBe("2026-03-01T00:10:00.000Z");

    const claim = await target.app.request(
      "/api/pair/claim",
      json("POST", { code: pair.code, device: { name: "Phone", platform: "android" } }),
    );
    expect(claim.status).toBe(201);
    const claimed = ClaimPairResponse.parse(await claim.json());
    expect(claimed.device.name).toBe("Phone");
    expect(hasInternalDeviceFields(claimed.device)).toBe(false);
    expect((await target.devices.authenticate(claimed.token))?.id).toBe(claimed.device.id);

    const reused = await target.app.request(
      "/api/pair/claim",
      json("POST", { code: pair.code, device: { name: "Phone", platform: "android" } }),
    );
    expect(reused.status).toBe(410);
  });

  test("rejects expired, unknown, and non-Android claims", async () => {
    const target = await initializedFixture();
    const created = CreatePairResponse.parse(
      await (
        await target.app.request("/api/pair", {
          method: "POST",
          headers: authorization(target.owner.token),
        })
      ).json(),
    );
    const wrongPlatform = await target.app.request(
      "/api/pair/claim",
      json("POST", { code: created.code, device: { name: "CLI", platform: "cli" } }),
    );
    expect(wrongPlatform.status).toBe(400);

    target.advance(10 * 60 * 1_000);
    const expired = await target.app.request(
      "/api/pair/claim",
      json("POST", { code: created.code, device: { name: "Phone", platform: "android" } }),
    );
    expect(expired.status).toBe(410);
    const unknown = await target.app.request(
      "/api/pair/claim",
      json("POST", {
        code: b64uEncode(new Uint8Array(16).fill(8)),
        device: { name: "Phone", platform: "android" },
      }),
    );
    expect(unknown.status).toBe(410);
  });

  test("concurrent claims have exactly one winner", async () => {
    const target = await initializedFixture();
    const pair = CreatePairResponse.parse(
      await (
        await target.app.request("/api/pair", {
          method: "POST",
          headers: authorization(target.owner.token),
        })
      ).json(),
    );
    const responses = await Promise.all([
      target.app.request(
        "/api/pair/claim",
        json("POST", { code: pair.code, device: { name: "Phone A", platform: "android" } }),
      ),
      target.app.request(
        "/api/pair/claim",
        json("POST", { code: pair.code, device: { name: "Phone B", platform: "android" } }),
      ),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 410]);
    expect(target.devices.list()).toHaveLength(2);
  });
});
