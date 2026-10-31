import { describe, expect, test } from "vitest";
import { b64uEncode, buildPairingUri, parsePairingUri } from "./index.js";

const mk = new Uint8Array(32).map((_, index) => index);
const codeBytes = new Uint8Array(16).map((_, index) => 0xf0 - index);
const key = b64uEncode(mk);
const code = b64uEncode(codeBytes);
const origin = "https://example.test:8443";

function pairingUri(values: { v?: string; u?: string; c?: string; k?: string } = {}): string {
  const query = new URLSearchParams({
    v: values.v ?? "1",
    u: values.u ?? origin,
    c: values.c ?? code,
    k: values.k ?? key,
  });
  return `pneumo://pair?${query}`;
}

describe("pairing URI", () => {
  test.each([
    "https://example.test",
    "https://example.test:8443",
    "http://localhost:3000",
    "http://127.0.0.1",
    "https://[2001:db8::1]:9443",
  ])("round-trips the exact HTTP(S) origin %s", (validOrigin) => {
    const uri = buildPairingUri({ origin: validOrigin, code, mk });

    expect(uri.startsWith("pneumo://pair?")).toBe(true);
    expect(parsePairingUri(uri)).toEqual({ origin: validOrigin, code, mk });
  });

  test.each([
    ["HTTP URL", `https://pair?${new URL(pairingUri()).searchParams}`],
    ["wrong host", pairingUri().replace("pneumo://pair?", "pneumo://other?")],
    ["missing authority slashes", pairingUri().replace("pneumo://", "pneumo:")],
    ["uppercase scheme", pairingUri().replace("pneumo://", "PNEUMO://")],
    ["userinfo", pairingUri().replace("pneumo://pair", "pneumo://user:pass@pair")],
    ["path", pairingUri().replace("pneumo://pair?", "pneumo://pair/path?")],
    ["fragment", `${pairingUri()}#fragment`],
  ])("rejects a pairing URI with %s", (_rule, uri) => {
    expect(() => parsePairingUri(uri)).toThrow();
  });

  test("rejects each missing parameter", () => {
    for (const name of ["v", "u", "c", "k"]) {
      const parsed = new URL(pairingUri());
      parsed.searchParams.delete(name);
      expect(() => parsePairingUri(parsed.toString())).toThrow();
    }
  });

  test("rejects every duplicated parameter and any extra parameter", () => {
    for (const name of ["v", "u", "c", "k"]) {
      const parsed = new URL(pairingUri());
      parsed.searchParams.append(name, parsed.searchParams.get(name) ?? "");
      expect(() => parsePairingUri(parsed.toString())).toThrow();
    }

    const extra = new URL(pairingUri());
    extra.searchParams.set("x", "unexpected");
    expect(() => parsePairingUri(extra.toString())).toThrow();
  });

  test.each(["", "0", "2", "01"])("rejects pairing version %s", (version) => {
    expect(() => parsePairingUri(pairingUri({ v: version }))).toThrow();
  });

  test.each([
    ["invalid alphabet", `${key.slice(0, -1)}*`],
    ["padding", `${key}=`],
    ["non-zero pad bits", `${key.slice(0, -1)}B`],
    ["31-byte key", b64uEncode(new Uint8Array(31))],
    ["33-byte key", b64uEncode(new Uint8Array(33))],
    ["empty key", ""],
  ])("rejects a master key with %s", (_rule, invalidKey) => {
    expect(() => parsePairingUri(pairingUri({ k: invalidKey }))).toThrow();
  });

  test.each([
    ["invalid alphabet", `${code.slice(0, -1)}*`],
    ["padding", `${code}=`],
    ["non-zero pad bits", `${code.slice(0, -1)}B`],
    ["15-byte code", b64uEncode(new Uint8Array(15))],
    ["17-byte code", b64uEncode(new Uint8Array(17))],
    ["empty code", ""],
  ])("rejects a pairing code with %s", (_rule, invalidCode) => {
    expect(() => parsePairingUri(pairingUri({ c: invalidCode }))).toThrow();
    expect(() => buildPairingUri({ origin, code: invalidCode, mk })).toThrow();
  });

  test.each([
    ["non-HTTP scheme", "ftp://example.test"],
    ["credentials", "https://user:password@example.test"],
    ["path", "https://example.test/path"],
    ["query", "https://example.test?query=value"],
    ["fragment", "https://example.test#fragment"],
    ["trailing slash", "https://example.test/"],
    ["noncanonical host case", "https://EXAMPLE.test"],
    ["explicit default port", "https://example.test:443"],
    ["relative URL", "/server"],
  ])("rejects an origin with %s", (_rule, invalidOrigin) => {
    expect(() => parsePairingUri(pairingUri({ u: invalidOrigin }))).toThrow();
    expect(() => buildPairingUri({ origin: invalidOrigin, code, mk })).toThrow();
  });

  test.each([0, 1, 15, 31, 33])("rejects a %i-byte master key when building", (length) => {
    expect(() => buildPairingUri({ origin, code, mk: new Uint8Array(length) })).toThrow();
  });
});
