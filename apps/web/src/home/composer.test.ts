import { webcrypto } from "node:crypto";
import { encryptPush } from "@pneumo/crypto";
import type { PushPayload } from "@pneumo/protocol";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { envelopeByteLength } from "./payload.js";

const pushId = "019a3598-c400-7000-8000-000000000001";
let contentKey: CryptoKey;

beforeAll(async () => {
  vi.stubGlobal("crypto", webcrypto);
  contentKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
  ]);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("envelopeByteLength", () => {
  test.each<PushPayload>([
    { type: "note", body: 'escaped: \\" \\\\ \\n \\t' },
    { type: "note", title: "Unicode 👩🏽‍💻", body: "雪だるま ☃ and café" },
    { type: "note", body: "unpaired surrogate: \ud800" },
    { type: "link", title: 'A quoted "title"', url: "https://example.test/a?x=雪" },
  ])("matches the serialized output of encryptPush for %#", async (payload) => {
    const envelope = await encryptPush(contentKey, pushId, payload);
    const actualBytes = new TextEncoder().encode(JSON.stringify(envelope)).byteLength;

    expect(envelopeByteLength(payload)).toBe(actualBytes);
  });

  test("changes at the same one-byte boundary as the encrypted envelope", async () => {
    const within: PushPayload = { type: "note", body: "é" };
    const over: PushPayload = { type: "note", body: "éa" };
    const withinEnvelope = await encryptPush(contentKey, pushId, within);
    const overEnvelope = await encryptPush(contentKey, pushId, over);
    const actualWithin = new TextEncoder().encode(JSON.stringify(withinEnvelope)).byteLength;
    const actualOver = new TextEncoder().encode(JSON.stringify(overEnvelope)).byteLength;

    expect(envelopeByteLength(within)).toBe(actualWithin);
    expect(envelopeByteLength(over)).toBe(actualOver);
    expect(envelopeByteLength(within) <= actualWithin).toBe(true);
    expect(envelopeByteLength(over) > actualWithin).toBe(true);
  });
});
