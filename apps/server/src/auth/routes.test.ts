import { Writable } from "node:stream";
import { b64uEncode, deriveKeys, deriveMasterKey, keyCheck, newKdfParams } from "@pneumo/crypto";
import {
  AuthParamsResponse,
  ErrorBody,
  LoginResponse,
  type SetupRequest,
  SetupResponse,
} from "@pneumo/protocol";
import type { Hono } from "hono";
import { beforeAll, describe, expect, test } from "vitest";
import { type AppEnv, type Clock, createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { DeviceRegistry } from "../devices/registry.js";
import { EventBus } from "../events.js";
import { InstanceState } from "../instance/state.js";
import { createLogger } from "../log.js";
import { MemoryStorage } from "../storage/memory.js";
import { loadVapidKeys } from "../webpush/vapid.js";

const SETUP_TOKEN = "fixed-test-setup";
const PASSPHRASE = "correct horse battery staple";
const WRONG_AUTH_KEY = b64uEncode(new Uint8Array(32).fill(0x5a));
let setupBody: SetupRequest;

beforeAll(async () => {
  const kdf = newKdfParams();
  const masterKey = await deriveMasterKey(PASSPHRASE, kdf);
  const keys = await deriveKeys(masterKey);
  setupBody = {
    setupToken: SETUP_TOKEN,
    kdf,
    authKey: b64uEncode(keys.authKey),
    keyCheck: b64uEncode(await keyCheck(masterKey)),
    device: { name: "Owner browser", platform: "web" },
  };
}, 30_000);

async function fixture(options: { trustProxy?: boolean; setupToken?: string } = {}) {
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const config = loadConfig({
    PUBLIC_URL: "https://pneumo.example",
    S3_ENDPOINT: "https://objects.example",
    S3_BUCKET: "test-bucket",
    S3_ACCESS_KEY_ID: "fake-access-key",
    S3_SECRET_ACCESS_KEY: "fake-secret-key",
    PNEUMO_SETUP_TOKEN: options.setupToken ?? SETUP_TOKEN,
    TRUST_PROXY: String(options.trustProxy ?? false),
    LOG_LEVEL: "info",
  });
  const clock: Clock = { now: () => now };
  const storage = new MemoryStorage({ now: clock.now });
  const logger = createLogger("info", destination);
  const instanceState = await InstanceState.load({ storage, config, clock, logger });
  const devices = await DeviceRegistry.load({ storage, clock, events: new EventBus() });
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
  return {
    app,
    clock,
    config,
    devices,
    instanceState,
    lines,
    storage,
    advance(ms: number) {
      now += ms;
    },
  };
}

function json(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

async function setup(target: { app: Hono<AppEnv> }) {
  const response = await target.app.request("/api/setup", json(setupBody));
  expect(response.status).toBe(201);
  return SetupResponse.parse(await response.json());
}

function remote(ip: string) {
  return { incoming: { socket: { remoteAddress: ip } } } as never;
}

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function expectProtocolError(body: unknown, code: string) {
  const error = ErrorBody.parse(body);
  expect(error.error.code).toBe(code);
}

function expectNoDeviceSecrets(value: unknown) {
  const serialized = JSON.stringify(value);
  expect(serialized.includes("tokenHash")).toBe(false);
  expect(serialized.includes("webPush")).toBe(false);
  expect(serialized.includes("authVerifier")).toBe(false);
  expect(serialized.includes("authKey")).toBe(false);
}

describe("setup and auth routes", () => {
  test("setup rejects a missing or wrong token, initializes once, and returns no stored secrets", async () => {
    for (const candidate of [undefined, "wrong-setup-token"]) {
      const target = await fixture();
      const body = { ...setupBody } as Partial<SetupRequest>;
      if (candidate === undefined) delete body.setupToken;
      else body.setupToken = candidate;
      const denied = await target.app.request("/api/setup", json(body));
      expect(denied.status).toBe(403);
      expectProtocolError(await denied.json(), "forbidden");
      expect(target.instanceState.initialized).toBe(false);
    }

    const malformedTarget = await fixture();
    const malformed = await malformedTarget.app.request(
      "/api/setup",
      json({ ...setupBody, authKey: "not-base64url-key-material" }),
    );
    expect(malformed.status).toBe(400);
    expectProtocolError(await malformed.json(), "bad_request");
    expect(malformedTarget.instanceState.initialized).toBe(false);

    const target = await fixture();
    const created = await setup(target);
    expect(created.device.name).toBe("Owner browser");
    expect(created.device.online).toBe(false);
    expectNoDeviceSecrets(created);
    const second = await target.app.request("/api/setup", json(setupBody));
    expect(second.status).toBe(409);
    expectProtocolError(await second.json(), "conflict");
  });

  test("concurrent setup has exactly one winner", async () => {
    const target = await fixture();
    const responses = await Promise.all([
      target.app.request("/api/setup", json(setupBody)),
      target.app.request("/api/setup", json(setupBody)),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const objects: string[] = [];
    for await (const object of target.storage.list("")) objects.push(object.key);
    expect(objects.filter((key) => key === "meta/owner.json")).toHaveLength(1);
    expect(objects.filter((key) => key.startsWith("devices/"))).toHaveLength(1);
  });

  test("auth params are unavailable before setup and expose only the configured KDF afterward", async () => {
    const target = await fixture();
    const before = await target.app.request("/api/auth/params");
    expect(before.status).toBe(409);
    expectProtocolError(await before.json(), "not_initialized");
    const loginBeforeSetup = await target.app.request("/api/auth/login", {
      method: "POST",
    });
    expect(loginBeforeSetup.status).toBe(409);
    expectProtocolError(await loginBeforeSetup.json(), "not_initialized");
    await setup(target);
    const response = await target.app.request("/api/auth/params");
    expect(response.status).toBe(200);
    const params = AuthParamsResponse.parse(await response.json());
    expect(params.kdf.alg).toBe("PBKDF2-SHA256");
    expect(params.kdf.iterations).toBe(600_000);
    expect(params.kdf.salt === setupBody.kdf.salt).toBe(true);
    expectNoDeviceSecrets(params);
  });

  test("login accepts the derived auth key and rejects a wrong one", async () => {
    const target = await fixture();
    await setup(target);
    const wrong = await target.app.request(
      "/api/auth/login",
      json({ authKey: WRONG_AUTH_KEY, device: { name: "Wrong", platform: "cli" } }),
      remote("192.0.2.1"),
    );
    expect(wrong.status).toBe(401);
    expectProtocolError(await wrong.json(), "unauthorized");

    const response = await target.app.request(
      "/api/auth/login",
      json({ authKey: setupBody.authKey, device: { name: "CLI", platform: "cli" } }),
      remote("192.0.2.1"),
    );
    expect(response.status).toBe(201);
    const loggedIn = LoginResponse.parse(await response.json());
    expect(loggedIn.device.name).toBe("CLI");
    expectNoDeviceSecrets(loggedIn);
  });

  test("the sixth failed login is rate limited with Retry-After and the window expires", async () => {
    const target = await fixture();
    await setup(target);
    const attempt = () =>
      target.app.request(
        "/api/auth/login",
        json({ authKey: WRONG_AUTH_KEY, device: { name: "CLI", platform: "cli" } }),
        remote("192.0.2.2"),
      );
    for (let index = 0; index < 5; index += 1) expect((await attempt()).status).toBe(401);
    const limited = await attempt();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("900");
    expectProtocolError(await limited.json(), "rate_limited");

    target.advance(15 * 60 * 1_000);
    const recovered = await target.app.request(
      "/api/auth/login",
      json({ authKey: setupBody.authKey, device: { name: "Recovered", platform: "cli" } }),
      remote("192.0.2.2"),
    );
    expect(recovered.status).toBe(201);
  });

  test("concurrent failures cannot bypass the per-IP limiter", async () => {
    const target = await fixture();
    await setup(target);
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        target.app.request(
          "/api/auth/login",
          json({ authKey: WRONG_AUTH_KEY, device: { name: "CLI", platform: "cli" } }),
          remote("192.0.2.22"),
        ),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([
      401, 401, 401, 401, 401, 429,
    ]);
  });

  test("a successful login resets only that IP failure counter", async () => {
    const target = await fixture();
    await setup(target);
    const request = (authKey: string) =>
      target.app.request(
        "/api/auth/login",
        json({ authKey, device: { name: "CLI", platform: "cli" } }),
        remote("192.0.2.3"),
      );
    for (let index = 0; index < 4; index += 1)
      expect((await request(WRONG_AUTH_KEY)).status).toBe(401);
    expect((await request(setupBody.authKey)).status).toBe(201);
    for (let index = 0; index < 5; index += 1)
      expect((await request(WRONG_AUTH_KEY)).status).toBe(401);
    expect((await request(WRONG_AUTH_KEY)).status).toBe(429);
  }, 30_000);

  test("the global limiter blocks a fresh IP after thirty failures", async () => {
    const target = await fixture();
    await setup(target);
    for (let ipIndex = 1; ipIndex <= 6; ipIndex += 1) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await target.app.request(
          "/api/auth/login",
          json({ authKey: WRONG_AUTH_KEY, device: { name: "CLI", platform: "cli" } }),
          remote(`198.51.100.${ipIndex}`),
        );
        expect(response.status).toBe(401);
      }
    }
    const response = await target.app.request(
      "/api/auth/login",
      json({ authKey: setupBody.authKey, device: { name: "CLI", platform: "cli" } }),
      remote("203.0.113.100"),
    );
    expect(response.status).toBe(429);
    expectProtocolError(await response.json(), "rate_limited");
  }, 30_000);

  test("TRUST_PROXY uses the first forwarded IP and otherwise ignores it", async () => {
    for (const [trustProxy, expected] of [
      [true, 401],
      [false, 429],
    ] as const) {
      const target = await fixture({ trustProxy });
      await setup(target);
      let lastStatus = 0;
      for (let index = 1; index <= 6; index += 1) {
        const response = await target.app.request(
          "/api/auth/login",
          json(
            { authKey: WRONG_AUTH_KEY, device: { name: "CLI", platform: "cli" } },
            { "X-Forwarded-For": `203.0.113.${index}, 10.0.0.1` },
          ),
          remote("192.0.2.44"),
        );
        lastStatus = response.status;
      }
      expect(lastStatus).toBe(expected);
    }
  }, 30_000);

  test("route logs omit setup, login, bearer, pairing and Web Push credentials", async () => {
    const target = await fixture();
    const owner = await setup(target);
    const login = await target.app.request(
      "/api/auth/login",
      json({ authKey: setupBody.authKey, device: { name: "Other browser", platform: "web" } }),
    );
    expect(login.status).toBe(201);
    const other = LoginResponse.parse(await login.json());
    const subscription = {
      endpoint: "https://push.example.test/private-subscription",
      keys: {
        p256dh: b64uEncode(new Uint8Array(65).fill(7)),
        auth: b64uEncode(new Uint8Array(16).fill(8)),
      },
    };
    const subscribed = await target.app.request("/api/devices/self/webpush", {
      ...json({ subscription }, auth(other.token)),
      method: "PUT",
    });
    expect(subscribed.status).toBe(204);
    const createdPair = await target.app.request("/api/pair", {
      method: "POST",
      headers: auth(owner.token),
    });
    expect(createdPair.status).toBe(201);
    const pair = (await createdPair.json()) as { code: string };
    const claimed = await target.app.request(
      "/api/pair/claim",
      json({ code: pair.code, device: { name: "Phone", platform: "android" } }),
    );
    expect(claimed.status).toBe(201);
    const phone = SetupResponse.parse(await claimed.json());
    const captured = target.lines.join("");
    const setupLog = target.lines
      .map((line) => JSON.parse(line))
      .find((row) => row.path === "/api/setup");
    expect(setupLog?.status).toBe(201);
    for (const secret of [
      SETUP_TOKEN,
      setupBody.authKey,
      owner.token,
      other.token,
      phone.token,
      pair.code,
      subscription.keys.p256dh,
      subscription.keys.auth,
    ]) {
      expect(captured.includes(secret)).toBe(false);
    }
  });
});

describe("JSON request handling", () => {
  const bodyRoutes = [
    { path: "/api/setup", auth: false, method: "POST", body: {} },
    {
      path: "/api/auth/login",
      method: "POST",
      auth: false,
      body: { authKey: WRONG_AUTH_KEY, device: { name: "CLI", platform: "cli" } },
    },
    { path: "/api/devices/placeholder", auth: true, method: "PATCH", body: { name: "Renamed" } },
    {
      path: "/api/devices/self/webpush",
      auth: true,
      method: "PUT",
      body: {
        subscription: {
          endpoint: "https://push.example.test/send",
          keys: { p256dh: b64uEncode(new Uint8Array(65)), auth: b64uEncode(new Uint8Array(16)) },
        },
      },
    },
    {
      path: "/api/pair/claim",
      method: "POST",
      auth: false,
      body: {
        code: b64uEncode(new Uint8Array(16)),
        device: { name: "Phone", platform: "android" },
      },
    },
  ] as const;

  test.each(bodyRoutes)("$method $path rejects non-JSON and malformed JSON", async (route) => {
    for (const [contentType, body] of [
      ["text/plain", JSON.stringify(route.body)],
      ["application/json", "{"],
    ] as const) {
      const target = await fixture();
      const owner = route.path === "/api/setup" ? undefined : await setup(target);
      const path = route.path.replace("placeholder", owner?.device.id ?? "placeholder");
      const response = await target.app.request(path, {
        method: route.method,
        headers: {
          "Content-Type": contentType,
          ...(route.auth && owner ? auth(owner.token) : {}),
        },
        body,
      });
      expect(response.status).toBe(400);
      expectProtocolError(await response.json(), "bad_request");
    }
  });

  test.each(bodyRoutes)("$method $path rejects JSON over 128 KiB", async (route) => {
    const target = await fixture();
    const owner = route.path === "/api/setup" ? undefined : await setup(target);
    const path = route.path.replace("placeholder", owner?.device.id ?? "placeholder");
    const response = await target.app.request(path, {
      method: route.method,
      headers: {
        "Content-Type": "application/json",
        ...(route.auth && owner ? auth(owner.token) : {}),
      },
      body: JSON.stringify({ padding: "x".repeat(128 * 1024) }),
    });
    expect(response.status).toBe(413);
    expectProtocolError(await response.json(), "payload_too_large");
  });
});
