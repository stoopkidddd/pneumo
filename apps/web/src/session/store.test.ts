import "fake-indexeddb/auto";
import { beforeEach, expect, test } from "vitest";
import { clear, load, type Session, save } from "./store.js";

function deleteDatabase(): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const request = indexedDB.deleteDatabase("pneumo");
  request.addEventListener("success", () => resolve(), { once: true });
  request.addEventListener("error", () => reject(request.error), { once: true });
  request.addEventListener(
    "blocked",
    () => reject(new Error("Session database deletion was blocked")),
    { once: true },
  );
  return promise;
}

async function createSession(): Promise<Session> {
  const contentKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  return {
    deviceId: "01900000-0000-7000-8000-000000000001",
    token: "fixed-fake-device-token",
    mk: new Uint8Array([1, 2, 3, 4]),
    contentKey,
  };
}

beforeEach(deleteDatabase);

test("persists the complete session through an IndexedDB structured clone", async () => {
  const session = await createSession();
  await save(session);
  session.mk[0] = 99;

  const restored = await load();

  expect(restored).not.toBeNull();
  expect(restored?.deviceId).toBe(session.deviceId);
  expect(restored?.token).toBe(session.token);
  expect(restored?.mk).toEqual(new Uint8Array([1, 2, 3, 4]));
});

test("preserves a usable non-extractable content key", async () => {
  await save(await createSession());
  const restored = await load();
  if (!restored) throw new Error("Expected a persisted session");

  const iv = new Uint8Array(12);
  const plaintext = new TextEncoder().encode("structured clone");
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    restored.contentKey,
    plaintext,
  );
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    restored.contentKey,
    ciphertext,
  );

  expect(new Uint8Array(decrypted)).toEqual(plaintext);
  await expect(crypto.subtle.exportKey("raw", restored.contentKey)).rejects.toThrow();
});

test("clear removes the persisted session", async () => {
  await save(await createSession());

  await clear();

  await expect(load()).resolves.toBeNull();
});
