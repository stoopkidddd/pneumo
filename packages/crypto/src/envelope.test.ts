import type { Envelope, PushPayload } from "@pneumo/protocol";
import { PUSH_AAD_PREFIX } from "@pneumo/protocol";
import fc from "fast-check";
import { beforeAll, describe, expect, test } from "vitest";
import { b64uDecode, b64uEncode, decryptPush, deriveKeys, encryptPush } from "./index.js";

const pushId = "019a33b0-4200-7000-8000-000000000001";
const otherPushId = "019a33b0-4200-7000-8000-000000000002";
const encoder = new TextEncoder();
const unicode = fc.string({ unit: "binary", maxLength: 80 });
const optionalUnicode = fc.option(unicode, { nil: undefined });

const notePayload = fc
  .tuple(unicode, optionalUnicode)
  .map(
    ([body, title]): PushPayload =>
      title === undefined ? { type: "note", body } : { type: "note", title, body },
  );
const linkPayload = fc
  .tuple(unicode, unicode, optionalUnicode)
  .map(([path, body, title]): PushPayload => {
    const base = { type: "link" as const, url: `https://example.test/${encodeURIComponent(path)}` };
    if (body === "" && title === undefined) return base;
    if (title === undefined) return { ...base, body };
    return { ...base, title, body };
  });
const filePayload = fc
  .tuple(
    unicode,
    unicode,
    fc.integer({ min: 0, max: 300_000 }),
    fc.uint8Array({ minLength: 32, maxLength: 32 }),
    optionalUnicode,
    optionalUnicode,
  )
  .map(([name, mime, size, key, title, body]): PushPayload => {
    const base = {
      type: "file" as const,
      file: { name, mime, size, key: b64uEncode(key) },
    };
    if (title === undefined && body === undefined) return base;
    if (title === undefined) return { ...base, body };
    if (body === undefined) return { ...base, title };
    return { ...base, title, body };
  });

let contentKey: CryptoKey;

beforeAll(async () => {
  ({ contentKey } = await deriveKeys(new Uint8Array(32).fill(0x5a)));
});

async function encryptRawJson(json: string): Promise<Envelope> {
  const nonce = new Uint8Array(12).fill(0xa5);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: encoder.encode(PUSH_AAD_PREFIX + pushId),
    },
    contentKey,
    encoder.encode(json),
  );
  return { v: 1, n: b64uEncode(nonce), c: b64uEncode(new Uint8Array(ciphertext)) };
}

describe("push envelopes", () => {
  test.each([
    ["note", notePayload, 31],
    ["link", linkPayload, 32],
    ["file", filePayload, 33],
  ] as const)("round-trips random Unicode %s payloads", async (_type, arbitrary, seed) => {
    await fc.assert(
      fc.asyncProperty(arbitrary, async (payload) => {
        const envelope = await encryptPush(contentKey, pushId, payload);

        expect(envelope.v).toBe(1);
        expect(b64uDecode(envelope.n)).toHaveLength(12);
        expect(b64uDecode(envelope.c).length).toBeGreaterThanOrEqual(16);
        await expect(decryptPush(contentKey, pushId, envelope)).resolves.toEqual(payload);
      }),
      { numRuns: 30, seed },
    );
  });

  test("authenticates the push ID as associated data", async () => {
    const envelope = await encryptPush(contentKey, pushId, {
      type: "note",
      title: "AAD",
      body: "bound to one push",
    });

    await expect(decryptPush(contentKey, otherPushId, envelope)).rejects.toThrow();
  });

  test("rejects every individual nonce-byte mutation", async () => {
    const envelope = await encryptPush(contentKey, pushId, { type: "note", body: "small" });
    const nonce = b64uDecode(envelope.n);

    for (let index = 0; index < nonce.length; index += 1) {
      const changed = nonce.slice();
      changed[index] = (changed[index] ?? 0) ^ 1;
      await expect(
        decryptPush(contentKey, pushId, { ...envelope, n: b64uEncode(changed) }),
      ).rejects.toThrow();
    }
  });

  test("rejects every individual ciphertext or tag byte mutation", async () => {
    const envelope = await encryptPush(contentKey, pushId, { type: "note", body: "small" });
    const ciphertext = b64uDecode(envelope.c);

    for (let index = 0; index < ciphertext.length; index += 1) {
      const changed = ciphertext.slice();
      changed[index] = (changed[index] ?? 0) ^ 1;
      await expect(
        decryptPush(contentKey, pushId, { ...envelope, c: b64uEncode(changed) }),
      ).rejects.toThrow();
    }
  });

  test("validates the decrypted payload instead of trusting authenticated JSON", async () => {
    const envelope = await encryptRawJson('{"type":"note","body":123}');

    await expect(decryptPush(contentKey, pushId, envelope)).rejects.toThrow();
  });

  test("rejects authenticated plaintext that is not JSON", async () => {
    const envelope = await encryptRawJson("not JSON");

    await expect(decryptPush(contentKey, pushId, envelope)).rejects.toThrow();
  });

  test("rejects malformed envelope fields before returning plaintext", async () => {
    const envelope = await encryptPush(contentKey, pushId, { type: "note", body: "valid" });
    await expect(
      decryptPush(contentKey, pushId, { ...envelope, v: 2 } as unknown as Envelope),
    ).rejects.toThrow();
    await expect(
      decryptPush(contentKey, pushId, { ...envelope, n: b64uEncode(new Uint8Array(11)) }),
    ).rejects.toThrow();
    await expect(
      decryptPush(contentKey, pushId, { ...envelope, c: b64uEncode(new Uint8Array(15)) }),
    ).rejects.toThrow();
  });
});
