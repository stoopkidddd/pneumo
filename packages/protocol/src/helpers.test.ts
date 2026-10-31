import fc from "fast-check";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  DEFAULT_KDF_ITERATIONS,
  DEFAULT_LIMITS,
  DEFAULT_UPLOAD_MODE,
  DEFAULT_WS_PING_SECONDS,
  FILE_AAD_PREFIX,
  FILE_CHUNK_SIZE,
  FILE_HEADER,
  HKDF_LABELS,
  KEY_CHECK_LABEL,
  MAX_OBJECT_TIMESTAMP_MS,
  PUSH_AAD_PREFIX,
  WS_CLOSE_CODES,
  WS_HELLO_TIMEOUT_MS,
} from "./constants.js";
import {
  ciphertextSize,
  detectLink,
  isUuidv7,
  parsePushObjectKey,
  pushObjectKey,
  uuidv7,
} from "./helpers.js";

const VALID_UUID_V7 = "018f05d2-a201-7abc-8def-0123456789ab";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("protocol constants", () => {
  test("matches the normative labels, framing, and defaults", () => {
    expect(HKDF_LABELS).toEqual({
      contentKey: "pneumo/v1/content",
      authKey: "pneumo/v1/auth",
      checkKey: "pneumo/v1/check",
    });
    expect(KEY_CHECK_LABEL).toBe("pneumo/v1/key-check");
    expect(PUSH_AAD_PREFIX).toBe("pneumo/v1/push:");
    expect(FILE_AAD_PREFIX).toBe("pneumo/v1/file:");
    expect(FILE_HEADER).toEqual([0x50, 0x4e, 0x4d, 0x46, 0x01, 0x00, 0x00, 0x00]);
    expect(FILE_CHUNK_SIZE).toBe(65_536);
    expect(DEFAULT_LIMITS).toEqual({
      maxFileBytes: 524_288_000,
      maxEnvelopeBytes: 65_536,
    });
    expect(DEFAULT_KDF_ITERATIONS).toBe(600_000);
    expect(DEFAULT_UPLOAD_MODE).toBe("auto");
    expect(DEFAULT_WS_PING_SECONDS).toBe(60);
    expect(WS_HELLO_TIMEOUT_MS).toBe(10_000);
    expect(WS_CLOSE_CODES).toEqual({
      protocolError: 4_400,
      unauthorized: 4_401,
      restarting: 1_012,
    });
    expect(MAX_OBJECT_TIMESTAMP_MS).toBe(9_999_999_999_999);
  });
});

describe("UUIDv7", () => {
  test("encodes the timestamp and fixes the version and RFC variant bits", () => {
    vi.spyOn(Date, "now").mockReturnValue(0x0123_4567_89ab);
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.fill(0xff);
      return bytes;
    });
    vi.stubGlobal("crypto", { getRandomValues });

    const id = uuidv7();

    expect(id).toBe("01234567-89ab-7fff-bfff-ffffffffffff");
    expect(Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16)).toBe(0x0123_4567_89ab);
    expect(id[14]).toBe("7");
    expect(id[19]).toMatch(/[89ab]/);
  });

  test("rejects system times outside the 48-bit UUIDv7 range", () => {
    vi.spyOn(Date, "now").mockReturnValue(-1);
    expect(() => uuidv7()).toThrow(RangeError);

    vi.mocked(Date.now).mockReturnValue(0x1_0000_0000_0000);
    expect(() => uuidv7()).toThrow(RangeError);
  });

  test.each([
    VALID_UUID_V7,
    "ffffffff-ffff-7000-8000-000000000000",
    "00000000-0000-7fff-bfff-ffffffffffff",
  ])("accepts lowercase canonical UUIDv7 %s", (id) => {
    expect(isUuidv7(id)).toBe(true);
  });

  test.each([
    ["uppercase", "018F05D2-A201-7ABC-8DEF-0123456789AB"],
    ["wrong version", "018f05d2-a201-4abc-8def-0123456789ab"],
    ["non-RFC variant", "018f05d2-a201-7abc-7def-0123456789ab"],
    ["missing hyphens", "018f05d2a2017abc8def0123456789ab"],
    ["braced", "{018f05d2-a201-7abc-8def-0123456789ab}"],
    ["surrounding whitespace", ` ${VALID_UUID_V7} `],
    ["non-hex character", "018f05d2-a201-7abc-8def-0123456789ag"],
    ["non-string", 123],
  ])("rejects a non-canonical ID: %s", (_rule, value) => {
    expect(isUuidv7(value)).toBe(false);
  });
});

describe("push object keys", () => {
  test("formats and parses a relative reverse-timestamp bucket key", () => {
    const createdAtMs = 1_700_000_000_123;
    const key = pushObjectKey(createdAtMs, VALID_UUID_V7);

    expect(key).toBe(`pushes/8299999999876_${VALID_UUID_V7}.json`);
    expect(parsePushObjectKey(key)).toEqual({ createdAtMs, id: VALID_UUID_V7 });
  });

  test("round-trips both supported timestamp boundaries", () => {
    for (const createdAtMs of [0, MAX_OBJECT_TIMESTAMP_MS]) {
      const key = pushObjectKey(createdAtMs, VALID_UUID_V7);
      expect(parsePushObjectKey(key)).toEqual({ createdAtMs, id: VALID_UUID_V7 });
    }
  });

  test("sorts strictly newest-first for every pair of distinct supported times", () => {
    const distinctTimes = fc
      .tuple(
        fc.integer({ min: 0, max: MAX_OBJECT_TIMESTAMP_MS }),
        fc.integer({ min: 0, max: MAX_OBJECT_TIMESTAMP_MS }),
      )
      .filter(([left, right]) => left !== right);

    fc.assert(
      fc.property(distinctTimes, ([left, right]) => {
        const leftKey = pushObjectKey(left, VALID_UUID_V7);
        const rightKey = pushObjectKey(right, VALID_UUID_V7);

        expect(leftKey === rightKey).toBe(false);
        expect(leftKey < rightKey).toBe(left > right);
      }),
      { numRuns: 1_000, seed: 243 },
    );
  });

  test.each([
    ["wrong directory", `archive/8299999999876_${VALID_UUID_V7}.json`],
    ["S3 prefix", `tenant/pushes/8299999999876_${VALID_UUID_V7}.json`],
    ["wrong extension", `pushes/8299999999876_${VALID_UUID_V7}.txt`],
    ["short inverse timestamp", `pushes/123_${VALID_UUID_V7}.json`],
    ["uppercase ID", "pushes/8299999999876_018F05D2-A201-7ABC-8DEF-0123456789AB.json"],
    ["wrong UUID version", "pushes/8299999999876_018f05d2-a201-4abc-8def-0123456789ab.json"],
  ])("rejects a malformed key: %s", (_rule, key) => {
    expect(parsePushObjectKey(key)).toBeNull();
  });

  test("throws rather than formatting invalid key inputs", () => {
    expect(() => pushObjectKey(-1, VALID_UUID_V7)).toThrow(RangeError);
    expect(() => pushObjectKey(1.5, VALID_UUID_V7)).toThrow(RangeError);
    expect(() => pushObjectKey(Number.NaN, VALID_UUID_V7)).toThrow(RangeError);
    expect(() => pushObjectKey(MAX_OBJECT_TIMESTAMP_MS + 1, VALID_UUID_V7)).toThrow(RangeError);
    expect(() => pushObjectKey("1" as never, VALID_UUID_V7)).toThrow(TypeError);
    expect(() => pushObjectKey(1, "018f05d2-a201-4abc-8def-0123456789ab")).toThrow(TypeError);
    expect(() => pushObjectKey(1, 123 as never)).toThrow(TypeError);
  });
});

describe("link detection", () => {
  test.each([
    "https://example.com",
    "http://localhost:8080/path?query=value#fragment",
    "https://[2001:db8::1]/path",
    "https://example.com/a%20path?q=%E2%9C%93",
    "https://例え.テスト/道",
    " \tHTTPS://example.com/path \n",
  ])("recognizes one complete HTTP(S) URL: %s", (text) => {
    expect(detectLink(text)).toBe(true);
  });

  test.each([
    ["empty text", ""],
    ["plain text", "read https://example.com"],
    ["bare host", "example.com"],
    ["unsupported scheme", "ftp://example.com/file"],
    ["missing slashes", "https:example.com"],
    ["missing host", "https://"],
    ["internal space", "https://exa mple.com"],
    ["multiple URLs", "https://one.example\nhttps://two.example"],
    ["invalid port", "https://example.com:99999"],
    ["invalid IPv6 host", "https://[not-an-ipv6-address]/"],
    ["non-string", 42],
  ])("rejects text that is not exactly one valid HTTP(S) URL: %s", (_rule, text) => {
    expect(detectLink(text as string)).toBe(false);
  });
});

describe("ciphertextSize", () => {
  test.each([
    [0, 24],
    [1, 25],
    [65_535, 65_559],
    [65_536, 65_560],
    [65_537, 65_577],
    [200_000, 200_072],
  ])("accounts for the header and one tag per chunk for %i plaintext bytes", (plain, cipher) => {
    expect(ciphertextSize(plain)).toBe(cipher);
  });

  test("rejects sizes that cannot produce an exact safe result", () => {
    expect(() => ciphertextSize(-1)).toThrow(RangeError);
    expect(() => ciphertextSize(1.5)).toThrow(RangeError);
    expect(() => ciphertextSize(Number.NaN)).toThrow(RangeError);
    expect(() => ciphertextSize(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => ciphertextSize(Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
    expect(() => ciphertextSize("1" as never)).toThrow(TypeError);
  });
});
