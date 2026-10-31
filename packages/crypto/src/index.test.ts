import type { Envelope, KdfParams, PushPayload } from "@pneumo/protocol";
import { DEFAULT_KDF_ITERATIONS } from "@pneumo/protocol";
import fc from "fast-check";
import { describe, expect, expectTypeOf, test } from "vitest";
import {
  b64uDecode,
  b64uEncode,
  buildPairingUri,
  createFileDecryptor,
  createFileEncryptor,
  type DerivedKeys,
  decryptBlob,
  decryptPush,
  deriveKeys,
  deriveMasterKey,
  encryptBlob,
  encryptPush,
  generateFileKey,
  keyCheck,
  newKdfParams,
  parsePairingUri,
} from "./index.js";

const fixedSalt = b64uEncode(
  new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
);
const fastKdf = { alg: "PBKDF2-SHA256", iterations: 1_000, salt: fixedSalt } as const;

describe("base64url", () => {
  test.each([
    [[], ""],
    [[0], "AA"],
    [[0, 0], "AAA"],
    [[0, 0, 0], "AAAA"],
    [[0xff], "_w"],
    [[0xfb, 0xff], "-_8"],
    [[0xfb, 0xff, 0xff], "-___"],
  ] as const)("encodes the RFC 4648 boundary case %# without padding", (input, encoded) => {
    expect(b64uEncode(new Uint8Array(input))).toBe(encoded);
    expect(b64uDecode(encoded)).toEqual(new Uint8Array(input));
  });

  test("round-trips arbitrary bytes in canonical unpadded form", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 2_048 }), (bytes) => {
        const encoded = b64uEncode(bytes);
        expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
        expect(encoded).not.toContain("=");
        expect(b64uEncode(b64uDecode(encoded))).toBe(encoded);
        expect(b64uDecode(encoded)).toEqual(bytes);
      }),
      { numRuns: 200, seed: 245 },
    );
  });

  test.each([
    ["length modulo four is one", "A"],
    ["non-zero pad bits in a two-character tail", "AB"],
    ["non-zero pad bits in a three-character tail", "AAB"],
    ["padding", "AA="],
    ["standard base64 alphabet", "+w"],
    ["slash from standard base64", "/w"],
    ["whitespace", "AA\n"],
    ["non-ASCII", "é"],
  ])("rejects noncanonical input: %s", (_rule, encoded) => {
    expect(() => b64uDecode(encoded)).toThrow();
  });

  test("returns an ArrayBuffer-backed byte array", () => {
    const decoded = b64uDecode("AA");
    expect(decoded.buffer).toBeInstanceOf(ArrayBuffer);
    expectTypeOf(decoded).toEqualTypeOf<Uint8Array<ArrayBuffer>>();
  });
});

describe("keys", () => {
  test("creates random 16-byte salts at the normative default iteration count", () => {
    const first = newKdfParams();
    const second = newKdfParams();

    expect(first).toEqual({
      alg: "PBKDF2-SHA256",
      iterations: DEFAULT_KDF_ITERATIONS,
      salt: expect.any(String),
    });
    expect(b64uDecode(first.salt)).toHaveLength(16);
    expect(b64uDecode(second.salt)).toHaveLength(16);
    expect(second.salt).not.toBe(first.salt);
  });

  test("normalizes passphrases to NFC before deriving the master key", async () => {
    const decomposed = "Cafe\u0301 and A\u030A";
    const composed = decomposed.normalize("NFC");

    const [left, right] = await Promise.all([
      deriveMasterKey(decomposed, fastKdf),
      deriveMasterKey(composed, fastKdf),
    ]);

    expect(left).toEqual(right);
    expect(left).toHaveLength(32);
    expect(left.buffer).toBeInstanceOf(ArrayBuffer);
  });

  test("derives independent 32-byte subkeys and a non-extractable AES-256-GCM key", async () => {
    const mk = await deriveMasterKey("correct horse battery staple", fastKdf);
    const { contentKey, authKey } = await deriveKeys(mk);
    const check = await keyCheck(mk);

    expect(authKey).toHaveLength(32);
    expect(check).toHaveLength(32);
    expect(authKey).not.toEqual(check);
    expect(contentKey.type).toBe("secret");
    expect(contentKey.extractable).toBe(false);
    expect(contentKey.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    expect(contentKey.usages).toEqual(expect.arrayContaining(["encrypt", "decrypt"]));
    await expect(crypto.subtle.exportKey("raw", contentKey)).rejects.toThrow();
  });

  test("generates fresh 32-byte file keys", () => {
    const first = generateFileKey();
    const second = generateFileKey();

    expect(first).toHaveLength(32);
    expect(second).toHaveLength(32);
    expect(first.buffer).toBeInstanceOf(ArrayBuffer);
    expect(second).not.toEqual(first);
  });

  test.each([0, 1, 15, 31, 33])("rejects a %i-byte master key", async (length) => {
    await expect(deriveKeys(new Uint8Array(length))).rejects.toThrow();
    await expect(keyCheck(new Uint8Array(length))).rejects.toThrow();
  });
});

test("public functions expose the consumer DTO and Web API types", () => {
  expectTypeOf(newKdfParams).returns.toEqualTypeOf<KdfParams>();
  expectTypeOf(deriveMasterKey).returns.toEqualTypeOf<Promise<Uint8Array<ArrayBuffer>>>();
  expectTypeOf<DerivedKeys>().toEqualTypeOf<{
    contentKey: CryptoKey;
    authKey: Uint8Array<ArrayBuffer>;
  }>();
  expectTypeOf(deriveKeys).returns.toEqualTypeOf<Promise<DerivedKeys>>();
  expectTypeOf(keyCheck).returns.toEqualTypeOf<Promise<Uint8Array<ArrayBuffer>>>();
  expectTypeOf(encryptPush).returns.toEqualTypeOf<Promise<Envelope>>();
  expectTypeOf(decryptPush).returns.toEqualTypeOf<Promise<PushPayload>>();
  expectTypeOf(generateFileKey).returns.toEqualTypeOf<Uint8Array<ArrayBuffer>>();
  expectTypeOf(createFileEncryptor).returns.toEqualTypeOf<
    TransformStream<Uint8Array, Uint8Array>
  >();
  expectTypeOf(createFileDecryptor).returns.toEqualTypeOf<
    TransformStream<Uint8Array, Uint8Array>
  >();
  expectTypeOf(encryptBlob).returns.toEqualTypeOf<Promise<Blob>>();
  expectTypeOf(decryptBlob).returns.toEqualTypeOf<Promise<Blob>>();
  expectTypeOf(buildPairingUri).returns.toEqualTypeOf<string>();
  expectTypeOf(parsePairingUri).returns.toEqualTypeOf<{
    origin: string;
    code: string;
    mk: Uint8Array<ArrayBuffer>;
  }>();
});
