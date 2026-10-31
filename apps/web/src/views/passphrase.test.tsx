// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { PassphraseFields } from "./fields.js";
import { passphraseError } from "./passphrase.js";

afterEach(cleanup);

test("setup requires twelve characters and a matching confirmation", () => {
  expect(passphraseError("elevenchars", "elevenchars")).toContain("at least 12");
  expect(passphraseError("twelve chars", "twelve chars")).toBeNull();
  expect(passphraseError("twelve chars", "other phrase")).toContain("do not match");
});

test("counts NFC characters rather than UTF-16 units and uses the KDF normalization for matching", () => {
  const composed = "é".repeat(12);
  expect(passphraseError(composed, "e\u0301".repeat(12))).toBeNull();
  expect(passphraseError("e\u0301".repeat(6), "e\u0301".repeat(6))).toContain("at least 12");
  expect(passphraseError("😀".repeat(6), "😀".repeat(6))).toContain("at least 12");
});

test("show and hide applies to both setup inputs without changing their values", () => {
  render(<PassphraseFields setup />);
  const first = screen.getByLabelText("Passphrase") as HTMLInputElement;
  const repeated = screen.getByLabelText("Repeat passphrase") as HTMLInputElement;
  fireEvent.change(first, { target: { value: "fixed fake passphrase" } });
  fireEvent.change(repeated, { target: { value: "fixed fake passphrase" } });
  expect(first.type).toBe("password");
  fireEvent.click(screen.getByRole("button", { name: "Show passphrase" }));
  expect(first.type).toBe("text");
  expect(repeated.type).toBe("text");
  fireEvent.click(screen.getByRole("button", { name: "Hide passphrase" }));
  expect(first.type).toBe("password");
  expect(repeated.type).toBe("password");
  expect(first.value === repeated.value).toBe(true);
});
