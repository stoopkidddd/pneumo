import { expect, test } from "vitest";

test("provides WebCrypto SHA-256", async () => {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array());

  expect(Buffer.from(digest).toString("hex")).toBe(
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});
