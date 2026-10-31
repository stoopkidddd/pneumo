import { Buffer } from "node:buffer";
import { Writable } from "node:stream";
import { b64uEncode, deriveKeys, deriveMasterKey, keyCheck, newKdfParams } from "@pneumo/crypto";
import type { SetupRequest } from "@pneumo/protocol";
import { beforeAll, expect, test } from "vitest";
import type { Clock } from "../app.js";
import { type Config, loadConfig } from "../config.js";
import { createLogger } from "../log.js";
import { MemoryBucket, MemoryStorage } from "../storage/memory.js";
import { StorageError } from "../storage/types.js";
import { InstanceState } from "./state.js";

const FIXED_TOKEN = "fixed-test-setup";
let request: SetupRequest;

beforeAll(async () => {
  const kdf = newKdfParams();
  const masterKey = await deriveMasterKey("correct horse battery staple", kdf);
  const { authKey } = await deriveKeys(masterKey);
  request = {
    setupToken: FIXED_TOKEN,
    kdf,
    authKey: b64uEncode(authKey),
    keyCheck: b64uEncode(await keyCheck(masterKey)),
    device: { name: "Owner browser", platform: "web" },
  };
}, 30_000);

function config(setupToken: string | null = FIXED_TOKEN): Config {
  return loadConfig({
    PUBLIC_URL: "https://pneumo.example",
    S3_ENDPOINT: "https://objects.example",
    S3_BUCKET: "test-bucket",
    S3_ACCESS_KEY_ID: "fake-access-key",
    S3_SECRET_ACCESS_KEY: "fake-secret-key",
    ...(setupToken === null ? {} : { PNEUMO_SETUP_TOKEN: setupToken }),
  });
}

function capturedLogger() {
  const lines: string[] = [];
  return {
    lines,
    logger: createLogger(
      "warn",
      new Writable({
        write(chunk, _encoding, callback) {
          lines.push(chunk.toString());
          callback();
        },
      }),
    ),
  };
}

const clock: Clock = { now: () => Date.parse("2026-01-02T03:04:05.000Z") };

test("generated setup credentials are logged once per uninitialized boot and then only compared", async () => {
  const capture = capturedLogger();
  const state = await InstanceState.load({
    storage: new MemoryStorage(),
    config: config(null),
    clock,
    logger: capture.logger,
  });
  expect(capture.lines.length).toBe(1);
  const record = JSON.parse(capture.lines[0] ?? "null") as { level?: number; msg?: string };
  expect(record.level).toBe(40);
  const token = record.msg?.match(/#token=([^\s]+)$/u)?.[1];
  if (typeof token !== "string") throw new Error("Missing setup URL credential");
  expect(state.validSetupToken(token)).toBe(true);
  expect(await state.initialize({ ...request, setupToken: token })).toBe(true);
  expect(state.validSetupToken(token)).toBe(false);
  expect(capture.lines.length).toBe(1);
});

test("configured setup credentials are never logged", async () => {
  const capture = capturedLogger();
  const state = await InstanceState.load({
    storage: new MemoryStorage(),
    config: config(),
    clock,
    logger: capture.logger,
  });
  expect(state.validSetupToken(FIXED_TOKEN)).toBe(true);
  expect(capture.lines.length).toBe(0);
});

test("initialization stores a scrypt verifier rather than authKey and disables the setup token", async () => {
  const storage = new MemoryStorage();
  const capture = capturedLogger();
  const state = await InstanceState.load({
    storage,
    config: config(),
    clock,
    logger: capture.logger,
  });
  expect(await state.initialize(request)).toBe(true);
  expect(state.initialized).toBe(true);
  expect(state.validSetupToken(FIXED_TOKEN)).toBe(false);
  expect(await state.initialize(request)).toBe(false);

  const persisted = await storage.getJson<Record<string, unknown>>("meta/owner.json");
  expect("authKey" in persisted).toBe(false);
  expect(persisted.createdAt).toBe("2026-01-02T03:04:05.000Z");
  const verifier = persisted.authVerifier as Record<string, unknown>;
  expect(verifier.alg).toBe("scrypt");
  expect(verifier.N).toBe(16_384);
  expect(verifier.r).toBe(8);
  expect(verifier.p).toBe(1);
  expect(Buffer.from(String(verifier.salt), "base64url").byteLength).toBe(16);
  expect(Buffer.from(String(verifier.hash), "base64url").byteLength).toBe(32);
  const serialized = JSON.stringify(persisted);
  expect(serialized.includes(request.authKey)).toBe(false);
  expect(serialized.includes(FIXED_TOKEN)).toBe(false);
});

test("an initialized reload never generates or logs a setup credential", async () => {
  const storage = new MemoryStorage();
  const firstCapture = capturedLogger();
  const first = await InstanceState.load({
    storage,
    config: config(),
    clock,
    logger: firstCapture.logger,
  });
  await first.initialize(request);

  const reloadCapture = capturedLogger();
  const reloaded = await InstanceState.load({
    storage,
    config: config(null),
    clock,
    logger: reloadCapture.logger,
  });
  expect(reloaded.initialized).toBe(true);
  expect(reloaded.validSetupToken(FIXED_TOKEN)).toBe(false);
  expect(reloadCapture.lines.length).toBe(0);
});

test("a conditional-write loser adopts the persisted owner", async () => {
  const bucket = new MemoryBucket();
  const firstStorage = new MemoryStorage({ bucket });
  const secondStorage = new MemoryStorage({ bucket });
  const capture = capturedLogger();
  const first = await InstanceState.load({
    storage: firstStorage,
    config: config(),
    clock,
    logger: capture.logger,
  });
  const second = await InstanceState.load({
    storage: secondStorage,
    config: config(),
    clock,
    logger: capture.logger,
  });
  expect(await first.initialize(request)).toBe(true);
  expect(await second.initialize(request)).toBe(false);
  expect(second.initialized).toBe(true);
  expect(second.owner?.createdAt).toBe(first.owner?.createdAt);
});

test("storage without conditional writes uses the single-replica fallback", async () => {
  class UnsupportedConditionalStorage extends MemoryStorage {
    conditionalAttempts = 0;

    override async putJson(
      key: string,
      value: unknown,
      options: { ifNoneMatch?: "*" } = {},
    ): Promise<void> {
      if (options.ifNoneMatch === "*") {
        this.conditionalAttempts += 1;
        throw new StorageError("Unsupported", "put JSON");
      }
      await super.putJson(key, value, options);
    }
  }

  const storage = new UnsupportedConditionalStorage();
  const capture = capturedLogger();
  const state = await InstanceState.load({
    storage,
    config: config(),
    clock,
    logger: capture.logger,
  });
  expect(await state.initialize(request)).toBe(true);
  expect(storage.conditionalAttempts).toBe(1);
  expect(await storage.head("meta/owner.json")).not.toBeNull();
});
