// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApiClient } from "../api/client.js";
import { AuthView } from "./AuthView.js";

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
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

function enterPassphrase(setup: boolean) {
  fireEvent.change(screen.getByLabelText("Passphrase"), {
    target: { value: "fixed fake passphrase" },
  });
  if (setup)
    fireEvent.change(screen.getByLabelText("Repeat passphrase"), {
      target: { value: "fixed fake passphrase" },
    });
  fireEvent.click(screen.getByRole("button", { name: setup ? "Create instance" : "Sign in" }));
}

test("login maps a server 401 to Wrong passphrase", async () => {
  window.history.replaceState(null, "", "/login");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (input === "/api/auth/params")
        return Response.json({
          kdf: { alg: "PBKDF2-SHA256", iterations: 1000, salt: "A".repeat(22) },
        });
      if (input === "/api/auth/login")
        return Response.json(
          {
            error: { code: "unauthorized", message: "Unauthorized" },
          },
          { status: 401 },
        );
      throw new Error("Unexpected authentication request");
    }),
  );
  const api = createApiClient({ onUnauthorized: vi.fn() });
  const signedIn = vi.fn();
  render(<AuthView setup={false} api={api} message={null} onSignedIn={signedIn} />);
  enterPassphrase(false);
  expect((await screen.findByRole("alert")).textContent).toBe("Wrong passphrase");
  expect(signedIn).not.toHaveBeenCalled();
});

test.each([
  { seconds: 120, minutes: 2 },
  { seconds: 121, minutes: 3 },
])(
  "login rounds Retry-After=$seconds seconds up to $minutes minutes",
  async ({ seconds, minutes }) => {
    window.history.replaceState(null, "", "/login");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (input === "/api/auth/params")
          return Response.json({
            kdf: { alg: "PBKDF2-SHA256", iterations: 1000, salt: "A".repeat(22) },
          });
        if (input === "/api/auth/login")
          return Response.json(
            {
              error: { code: "rate_limited", message: "Slow down" },
            },
            { status: 429, headers: { "Retry-After": String(seconds) } },
          );
        throw new Error("Unexpected authentication request");
      }),
    );
    const api = createApiClient({ onUnauthorized: vi.fn() });
    const signedIn = vi.fn();
    render(<AuthView setup={false} api={api} message={null} onSignedIn={signedIn} />);
    enterPassphrase(false);
    expect((await screen.findByRole("alert")).textContent).toBe(
      `Too many attempts. Try again in ${minutes} minutes`,
    );
    expect(signedIn).not.toHaveBeenCalled();
  },
);

test.each([
  {
    status: 403,
    code: "forbidden",
    expected: "This setup token is not valid. Open the setup link provided by your server.",
  },
  {
    status: 409,
    code: "conflict",
    expected: "This instance is already set up. Open Sign in to continue.",
  },
])("setup explains the recovery action for HTTP $status", async ({ status, code, expected }) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (input === "/api/setup")
        return Response.json(
          {
            error: { code, message: "Setup rejected" },
          },
          { status },
        );
      throw new Error("Unexpected setup request");
    }),
  );
  const api = createApiClient({ onUnauthorized: vi.fn() });
  const signedIn = vi.fn();
  render(<AuthView setup api={api} message={null} onSignedIn={signedIn} />);
  enterPassphrase(true);
  expect((await screen.findByRole("alert")).textContent).toBe(expected);
  expect(signedIn).not.toHaveBeenCalled();
});
