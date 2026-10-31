// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "./App.js";
import { clear, load, save } from "./session/store.js";

const device = {
  id: "019a3598-c400-7000-8000-000000000001",
  name: "Office browser",
  platform: "web",
  createdAt: "2026-10-31T00:00:00.000Z",
  lastSeenAt: "2026-10-31T00:00:00.000Z",
  online: false,
};

function server(initialized: boolean, revoked = false) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (input === "/api/health")
        return Response.json({ ok: true, initialized, version: "0.1.0" });
      if (input === "/api/me")
        return revoked
          ? Response.json(
              { error: { code: "unauthorized", message: "Unauthorized" } },
              { status: 401 },
            )
          : Response.json({
              device,
              keyCheck: "A".repeat(43),
              limits: { maxFileBytes: 524288000, maxEnvelopeBytes: 65536 },
              vapidPublicKey: "A".repeat(87),
              uploadMode: "direct",
            });
      throw new Error("Unexpected request in guard test");
    }),
  );
}

async function storedSession() {
  const contentKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  await save({ deviceId: device.id, token: "A".repeat(43), mk: new Uint8Array(32), contentKey });
}

beforeEach(async () => {
  vi.stubGlobal("crypto", webcrypto);
  window.history.replaceState(null, "", "/");
  await clear();
});
afterEach(async () => {
  cleanup();
  await clear();
  vi.unstubAllGlobals();
});

test("uninitialized instance sends a protected deep link to setup", async () => {
  server(false);
  window.history.replaceState(null, "", "/settings");
  render(<App />);
  await screen.findByRole("heading", { name: "Set up Pneumo" });
  expect(window.location.pathname).toBe("/setup");
  expect(screen.getByRole("alert").textContent).toContain("Setup token is missing");
});

test("setup redirect retains fragment token for the form, then removes it from history", async () => {
  server(false);
  window.history.replaceState(null, "", "/#token=fixed-fake-setup-token");
  render(<App />);
  await screen.findByRole("button", { name: "Create instance" });
  expect(window.location.pathname).toBe("/setup");
  expect(window.location.hash).toBe("");
  expect(screen.queryByRole("alert")).toBeNull();
});

test("initialized signed-out deep link redirects to login", async () => {
  server(true);
  window.history.replaceState(null, "", "/devices");
  render(<App />);
  await screen.findByRole("heading", { name: "Sign in" });
  expect(window.location.pathname).toBe("/login");
});

test("a persisted authenticated session redirects away from login to Home", async () => {
  server(true);
  await storedSession();
  window.history.replaceState(null, "", "/login");
  render(<App />);
  await screen.findByRole("heading", { name: "Home" });
  await waitFor(() => expect(window.location.pathname).toBe("/"));
  expect(screen.getByRole("navigation").textContent).toContain("Settings");
});

test("settings reads the current device name from the authenticated server", async () => {
  server(true);
  await storedSession();
  window.history.replaceState(null, "", "/settings");
  render(<App />);
  const name = (await screen.findByLabelText("Device name")) as HTMLInputElement;
  expect(name.value).toBe("Office browser");
});

test("revoked stored token clears persisted keys and opens login with a message", async () => {
  server(true, true);
  await storedSession();
  window.history.replaceState(null, "", "/settings");
  render(<App />);
  await screen.findByRole("heading", { name: "Sign in" });
  expect(await load()).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("session is no longer valid");
  expect(window.location.pathname).toBe("/login");
});

test("health failure does not pretend the instance needs setup", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Offline")));
  render(<App />);
  await screen.findByRole("heading", { name: "Connection unavailable" });
  expect(screen.queryByRole("heading", { name: "Set up Pneumo" })).toBeNull();
});

test("offline startup retains a stored session and opens the cached Home shell", async () => {
  await storedSession();
  const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Offline")));
  try {
    render(<App />);
    await screen.findByRole("heading", { name: "Home" });
    expect(screen.getByText(/Offline\. Your loaded history/)).toBeTruthy();
    expect(await load()).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "Sign in" })).toBeNull();
  } finally {
    online.mockRestore();
  }
});
