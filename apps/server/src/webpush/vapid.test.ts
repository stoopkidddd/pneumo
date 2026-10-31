import { createECDH } from "node:crypto";
import { expect, test, vi } from "vitest";
import { MemoryStorage } from "../storage/memory.js";
import { StorageError } from "../storage/types.js";
import { loadVapidKeys, type VapidKeys } from "./vapid.js";

const config = { VAPID_SUBJECT: "mailto:owner@example.test" };

test("first boot persists a P-256 keypair and subsequent boots reuse it", async () => {
  const storage = new MemoryStorage();
  const first = await loadVapidKeys({ storage, config });
  const persisted = await storage.getJson<VapidKeys>("meta/vapid.json");
  expect(JSON.stringify(persisted) === JSON.stringify(first)).toBe(true);
  expect(persisted.subject).toBe(config.VAPID_SUBJECT);
  expect(Buffer.from(first.publicKey, "base64url").length).toBe(65);
  const curve = createECDH("prime256v1");
  curve.setPrivateKey(Buffer.from(first.privateKey, "base64url"));
  expect(curve.getPublicKey().toString("base64url") === first.publicKey).toBe(true);

  const second = await loadVapidKeys({ storage, config });
  expect(second.publicKey).toBe(first.publicKey);
  expect(second.privateKey === first.privateKey).toBe(true);
  expect(second.subject).toBe(first.subject);
  const reloaded = await storage.getJson<VapidKeys>("meta/vapid.json");
  expect(JSON.stringify(reloaded) === JSON.stringify(persisted)).toBe(true);
});

test("a storage read failure does not rotate the persisted signing keys", async () => {
  const storage = new MemoryStorage();
  const first = await loadVapidKeys({ storage, config });
  const failure = new StorageError("Other", "get JSON");
  vi.spyOn(storage, "getJson").mockRejectedValueOnce(failure);
  await expect(loadVapidKeys({ storage, config })).rejects.toBe(failure);
  const reloaded = await loadVapidKeys({ storage, config });
  expect(reloaded.publicKey).toBe(first.publicKey);
  expect(reloaded.privateKey === first.privateKey).toBe(true);
});
