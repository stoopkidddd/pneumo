// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApiClient } from "../api/client.js";
import { AuthView } from "./AuthView.js";

beforeEach(() => {
  window.history.replaceState(null, "", "/setup#token=fixed-fake-setup-token");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error("Validation must run before derivation or network")),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("setup rejects a short passphrase before it can create an owner", async () => {
  const signedIn = vi.fn();
  const api = createApiClient({ onUnauthorized: async () => {} });
  render(<AuthView setup api={api} message={null} onSignedIn={signedIn} />);
  fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "short" } });
  fireEvent.change(screen.getByLabelText("Repeat passphrase"), { target: { value: "short" } });
  fireEvent.click(screen.getByRole("button", { name: "Create instance" }));
  expect((await screen.findByRole("alert")).textContent).toContain("at least 12");
  expect(signedIn).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

test("setup explains a mismatched confirmation without losing the form", async () => {
  const api = createApiClient({ onUnauthorized: async () => {} });
  render(<AuthView setup api={api} message={null} onSignedIn={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Passphrase"), {
    target: { value: "fixed fake passphrase" },
  });
  fireEvent.change(screen.getByLabelText("Repeat passphrase"), {
    target: { value: "a different phrase" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create instance" }));
  expect((await screen.findByRole("alert")).textContent).toContain("do not match");
  expect(
    (screen.getByLabelText("Passphrase") as HTMLInputElement).value === "fixed fake passphrase",
  ).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});
