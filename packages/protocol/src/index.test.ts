import { expect, test } from "vitest";

test("encodes non-ASCII JSON text as UTF-8", () => {
  expect(new TextEncoder().encode("é")).toEqual(new Uint8Array([0xc3, 0xa9]));
});
