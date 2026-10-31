import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { b64uEncode, deriveKeys, deriveMasterKey, keyCheck, newKdfParams } from "@pneumo/crypto";
import {
  AuthParamsResponse,
  ClaimPairResponse,
  CreatePairResponse,
  ListDevicesResponse,
  LoginResponse,
  MeResponse,
  type SetupRequest,
  SetupResponse,
} from "@pneumo/protocol";
import { afterAll, beforeAll, expect, inject, test } from "vitest";
import packageJson from "../../package.json" with { type: "json" };
import { type Clock, createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { DeviceRegistry } from "../devices/registry.js";
import { EventBus } from "../events.js";
import { InstanceState } from "../instance/state.js";
import { createLogger } from "../log.js";
import { S3Storage } from "../storage/s3.js";
import { loadVapidKeys } from "../webpush/vapid.js";

const minio = inject("minio");
const serverDir = new URL("../../", import.meta.url);
const execute = promisify(execFile);
const SETUP_TOKEN = "fixed-e2e-setup-token";
let setupRequest: SetupRequest;
let webDist: string;
const html = "<!doctype html><html><body>Pneumo e2e fixture</body></html>";

function required(name: string): string {
  const value = minio[name];
  if (!value) throw new Error(`MinIO setup did not provide ${name}`);
  return value;
}

function randomPrefix(label: string): string {
  return `eng250/${label}/${randomUUID()}/`;
}

function s3Config(prefix: string) {
  return loadConfig({
    PUBLIC_URL: "http://localhost",
    S3_ENDPOINT: required("S3_ENDPOINT"),
    S3_REGION: required("S3_REGION"),
    S3_BUCKET: required("S3_BUCKET"),
    S3_ACCESS_KEY_ID: required("S3_ACCESS_KEY_ID"),
    S3_SECRET_ACCESS_KEY: required("S3_SECRET_ACCESS_KEY"),
    S3_FORCE_PATH_STYLE: required("S3_FORCE_PATH_STYLE"),
    S3_PREFIX: prefix,
    PNEUMO_SETUP_TOKEN: SETUP_TOKEN,
    UPLOAD_MODE: "proxy",
    LOG_LEVEL: "silent",
  });
}

async function cleanStorage(storage: S3Storage) {
  const keys: string[] = [];
  for await (const object of storage.list("")) keys.push(object.key);
  if (keys.length > 0) await storage.deleteMany(keys);
}

async function disposeStorage(storage: S3Storage) {
  try {
    await cleanStorage(storage);
  } finally {
    storage.destroy();
  }
}

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
  webDist = await mkdtemp(join(tmpdir(), "pneumo-auth-e2e-"));
  await writeFile(join(webDist, "index.html"), html);
  await execute("pnpm", ["run", "build"], { cwd: serverDir });
}, 120_000);

afterAll(async () => {
  await rm(webDist, { recursive: true, force: true });
});

test("MinIO persists the owner once and reloads and removes device records", async () => {
  const prefix = randomPrefix("persistence");
  const config = s3Config(prefix);
  const storage = new S3Storage(config);
  const logger = createLogger("silent");
  let now = Date.parse("2026-04-01T00:00:00.000Z");
  const clock: Clock = { now: () => now };
  try {
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
    const first = await app.request("/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(setupRequest),
    });
    expect(first.status).toBe(201);
    const owner = SetupResponse.parse(await first.json());
    const second = await app.request("/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(setupRequest),
    });
    expect(second.status).toBe(409);
    const renamed = await app.request(`/api/devices/${owner.device.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ name: "Renamed owner" }),
    });
    expect(renamed.status).toBe(200);
    const subscription = {
      endpoint: "https://push.example.test/persistent",
      keys: {
        p256dh: b64uEncode(new Uint8Array(65).fill(5)),
        auth: b64uEncode(new Uint8Array(16).fill(6)),
      },
    };
    const subscribed = await app.request("/api/devices/self/webpush", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ subscription }),
    });
    expect(subscribed.status).toBe(204);
    now += 60_000;
    const seen = await app.request("/api/me", {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    expect(seen.status).toBe(200);
    const seenMe = MeResponse.parse(await seen.json());
    expect(Buffer.from(seenMe.vapidPublicKey, "base64url").length).toBe(65);
    expect(seenMe.vapidPublicKey).toBe(vapidKeys.publicKey);

    const reloadedState = await InstanceState.load({ storage, config, clock, logger });
    const reloadedDevices = await DeviceRegistry.load({ storage, clock, events: new EventBus() });
    const reloadedVapidKeys = await loadVapidKeys({ storage, config });
    expect(reloadedVapidKeys.publicKey).toBe(vapidKeys.publicKey);
    expect(reloadedState.initialized).toBe(true);
    expect((await reloadedDevices.authenticate(owner.token))?.id).toBe(owner.device.id);
    expect(reloadedDevices.get(owner.device.id)?.name).toBe("Renamed owner");
    expect(reloadedDevices.get(owner.device.id)?.lastSeenAt).toBe(new Date(now).toISOString());
    const persisted = await storage.getJson<{ webPush: unknown }>(
      `devices/${owner.device.id}.json`,
    );
    expect(JSON.stringify(persisted.webPush) === JSON.stringify(subscription)).toBe(true);
    const reloadedApp = createApp({
      config,
      storage,
      clock,
      logger,
      instanceState: reloadedState,
      devices: reloadedDevices,
      uploadMode: "proxy",
      vapidPublicKey: reloadedVapidKeys.publicKey,
    });
    const cleared = await reloadedApp.request("/api/devices/self/webpush", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    expect(cleared.status).toBe(204);
    const clearedRecord = await storage.getJson<{ webPush: unknown }>(
      `devices/${owner.device.id}.json`,
    );
    expect(clearedRecord.webPush === null).toBe(true);

    expect(await reloadedDevices.remove(owner.device.id)).toBe(true);
    const afterDeletion = await DeviceRegistry.load({ storage, clock, events: new EventBus() });
    expect(afterDeletion.get(owner.device.id)).toBeNull();
    expect(await afterDeletion.authenticate(owner.token)).toBeNull();
    expect(await storage.head(`devices/${owner.device.id}.json`)).toBeNull();
  } finally {
    await disposeStorage(storage);
  }
});

function startRuntime(prefix: string): ChildProcess {
  return spawn(process.execPath, ["dist/index.js"], {
    cwd: serverDir,
    env: {
      PATH: process.env.PATH,
      PORT: "0",
      PUBLIC_URL: "http://localhost",
      S3_ENDPOINT: required("S3_ENDPOINT"),
      S3_REGION: required("S3_REGION"),
      S3_BUCKET: required("S3_BUCKET"),
      S3_ACCESS_KEY_ID: required("S3_ACCESS_KEY_ID"),
      S3_SECRET_ACCESS_KEY: required("S3_SECRET_ACCESS_KEY"),
      S3_FORCE_PATH_STYLE: required("S3_FORCE_PATH_STYLE"),
      S3_PREFIX: prefix,
      PNEUMO_SETUP_TOKEN: SETUP_TOKEN,
      UPLOAD_MODE: "proxy",
      WEB_DIST_DIR: webDist,
      LOG_LEVEL: "info",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function runtimePort(child: ChildProcess): Promise<{ port: number; output: () => string }> {
  const listening = Promise.withResolvers<number>();
  let output = "";
  let parsedLength = 0;
  const accept = (chunk: Buffer) => {
    output += chunk.toString();
    const completeLength = output.lastIndexOf("\n") + 1;
    if (completeLength <= parsedLength) return;
    for (const line of output.slice(parsedLength, completeLength).split("\n")) {
      if (!line) continue;
      try {
        const row = JSON.parse(line) as { msg?: string; port?: number };
        if (row.msg === "Server listening" && typeof row.port === "number")
          listening.resolve(row.port);
      } catch {
        // Child output is retained for assertions but never printed because it can contain credentials.
      }
    }
    parsedLength = completeLength;
  };
  child.stdout?.on("data", accept);
  child.stderr?.on("data", accept);
  child.once("exit", () => listening.reject(new Error("Server exited before listening")));
  const timer = setTimeout(() => listening.reject(new Error("Server did not start")), 15_000);
  try {
    return { port: await listening.promise, output: () => output };
  } finally {
    clearTimeout(timer);
  }
}

async function stopRuntime(
  child: ChildProcess,
): Promise<[code: number | null, signal: NodeJS.Signals | null]> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return [child.exitCode, child.signalCode];
  }
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    return (await exited) as [number | null, NodeJS.Signals | null];
  } finally {
    clearTimeout(timer);
  }
}

function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function requestJson(origin: string, path: string, body: unknown, token?: string) {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token === undefined ? {} : bearer(token)),
    },
    body: JSON.stringify(body),
  });
}

test("bundled runtime serves the changed auth and pairing paths and reloads MinIO state", async () => {
  const prefix = randomPrefix("runtime");
  const cleanup = new S3Storage(s3Config(prefix));
  let child: ChildProcess | undefined;
  let restarted: ChildProcess | undefined;
  try {
    child = startRuntime(prefix);
    const running = await runtimePort(child);
    const origin = `http://localhost:${running.port}`;

    const health = await fetch(`${origin}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      ok: true,
      version: packageJson.version,
      initialized: false,
    });
    const page = await fetch(`${origin}/devices/deep/link`);
    expect(page.status).toBe(200);
    expect(page.headers.get("Cache-Control")).toBe("no-cache");
    expect(await page.text()).toBe(html);

    const setupResponse = await requestJson(origin, "/api/setup", setupRequest);
    expect(setupResponse.status).toBe(201);
    const owner = SetupResponse.parse(await setupResponse.json());
    const paramsResponse = await fetch(`${origin}/api/auth/params`);
    const params = AuthParamsResponse.parse(await paramsResponse.json());
    expect(params.kdf.salt === setupRequest.kdf.salt).toBe(true);

    const loginResponse = await requestJson(origin, "/api/auth/login", {
      authKey: setupRequest.authKey,
      device: { name: "Second browser", platform: "web" },
    });
    expect(loginResponse.status).toBe(201);
    const second = LoginResponse.parse(await loginResponse.json());
    const meResponse = await fetch(`${origin}/api/me`, { headers: bearer(second.token) });
    expect(meResponse.status).toBe(200);
    const meBody: unknown = await meResponse.json();
    const me = MeResponse.parse(meBody);
    expect(me.keyCheck === setupRequest.keyCheck).toBe(true);
    expect(Buffer.from(me.vapidPublicKey, "base64url").length).toBe(65);
    const vapidKeys = await loadVapidKeys({ storage: cleanup, config: s3Config(prefix) });
    expect(me.vapidPublicKey).toBe(vapidKeys.publicKey);
    expect(JSON.stringify(meBody).includes(vapidKeys.privateKey)).toBe(false);

    const devices = ListDevicesResponse.parse(
      await (await fetch(`${origin}/api/devices`, { headers: bearer(owner.token) })).json(),
    );
    expect(devices.devices).toHaveLength(2);
    const pair = CreatePairResponse.parse(
      await (
        await fetch(`${origin}/api/pair`, { method: "POST", headers: bearer(owner.token) })
      ).json(),
    );
    const claimResponse = await requestJson(origin, "/api/pair/claim", {
      code: pair.code,
      device: { name: "Phone", platform: "android" },
    });
    const phone = ClaimPairResponse.parse(await claimResponse.json());
    const deletion = await fetch(`${origin}/api/devices/${phone.device.id}`, {
      method: "DELETE",
      headers: bearer(owner.token),
    });
    expect(deletion.status).toBe(204);
    expect((await fetch(`${origin}/api/me`, { headers: bearer(phone.token) })).status).toBe(401);
    expect(running.output().includes(owner.token)).toBe(false);
    expect(running.output().includes(second.token)).toBe(false);
    expect(running.output().includes(phone.token)).toBe(false);
    expect(running.output().includes(vapidKeys.privateKey)).toBe(false);

    const [exitCode, exitSignal] = await stopRuntime(child);
    expect(exitCode).toBe(0);
    expect(exitSignal).toBeNull();
    child = undefined;
    restarted = startRuntime(prefix);
    const reloaded = await runtimePort(restarted);
    const reloadedOrigin = `http://localhost:${reloaded.port}`;
    const reloadedHealth = await fetch(`${reloadedOrigin}/api/health`);
    expect(await reloadedHealth.json()).toEqual({
      ok: true,
      version: packageJson.version,
      initialized: true,
    });
    const reloadedMeResponse = await fetch(`${reloadedOrigin}/api/me`, {
      headers: bearer(owner.token),
    });
    expect(reloadedMeResponse.status).toBe(200);
    const reloadedMe = MeResponse.parse(await reloadedMeResponse.json());
    expect(reloadedMe.vapidPublicKey).toBe(me.vapidPublicKey);
    expect(reloaded.output().includes(vapidKeys.privateKey)).toBe(false);
    expect((await requestJson(reloadedOrigin, "/api/setup", setupRequest)).status).toBe(409);
  } finally {
    try {
      if (child) await stopRuntime(child);
    } finally {
      try {
        if (restarted) await stopRuntime(restarted);
      } finally {
        await disposeStorage(cleanup);
      }
    }
  }
}, 60_000);
