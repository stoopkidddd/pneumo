// @vitest-environment jsdom
import type { DeviceDTO } from "@pneumo/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApiClient } from "../api/client.js";
import { SettingsView } from "./SettingsView.js";

const storage = vi.hoisted(() => ({
  load: vi.fn().mockResolvedValue({ token: "fixed-fake-device-token" }),
  clear: vi.fn<() => Promise<void>>(),
}));
vi.mock("../session/store.js", () => storage);

const device: DeviceDTO = {
  id: "019a3598-c400-7000-8000-000000000001",
  name: "Office browser",
  platform: "web",
  createdAt: "2026-10-31T00:00:00.000Z",
  lastSeenAt: "2026-10-31T00:00:00.000Z",
  online: false,
};

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  storage.clear.mockReset();
  storage.clear.mockResolvedValue(undefined);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("sign out waits for device revocation and local deletion before leaving Settings", async () => {
  const revoked = Promise.withResolvers<Response>();
  const cleared = Promise.withResolvers<void>();
  fetchMock.mockReturnValue(revoked.promise);
  storage.clear.mockReturnValue(cleared.promise);
  const api = createApiClient({ onUnauthorized: vi.fn() });
  const signedOut = vi.fn();
  render(<SettingsView api={api} device={device} onSignedOut={signedOut} />);
  const button = screen.getByRole("button", { name: "Sign out" }) as HTMLButtonElement;

  fireEvent.click(button);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/devices/${device.id}`);
  expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("DELETE");
  expect(button.disabled).toBe(true);
  expect(storage.clear).not.toHaveBeenCalled();
  expect(signedOut).not.toHaveBeenCalled();

  await act(async () => {
    revoked.resolve(new Response(null, { status: 204 }));
  });
  expect(storage.clear).toHaveBeenCalledOnce();
  expect(signedOut).not.toHaveBeenCalled();
  expect(button.disabled).toBe(true);

  await act(async () => {
    cleared.resolve();
  });
  expect(signedOut).toHaveBeenCalledOnce();
});

test("a failed revocation retains local credentials and permits another sign-out attempt", async () => {
  fetchMock.mockRejectedValue(new TypeError("Offline"));
  const api = createApiClient({ onUnauthorized: vi.fn() });
  const signedOut = vi.fn();
  render(<SettingsView api={api} device={device} onSignedOut={signedOut} />);
  const button = screen.getByRole("button", { name: "Sign out" }) as HTMLButtonElement;

  fireEvent.click(button);
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Could not sign out. Check your connection and try again.",
  );
  expect(button.disabled).toBe(false);
  expect(storage.clear).not.toHaveBeenCalled();
  expect(signedOut).not.toHaveBeenCalled();
});

test("a 401 uses the global session handler without a misleading local error or duplicate cleanup", async () => {
  fetchMock.mockResolvedValue(
    Response.json({ error: { code: "unauthorized", message: "Unauthorized" } }, { status: 401 }),
  );
  const unauthorized = vi.fn();
  const api = createApiClient({ onUnauthorized: unauthorized });
  const signedOut = vi.fn();
  render(<SettingsView api={api} device={device} onSignedOut={signedOut} />);
  const button = screen.getByRole("button", { name: "Sign out" }) as HTMLButtonElement;

  fireEvent.click(button);
  await waitFor(() => expect(button.disabled).toBe(false));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(storage.clear).toHaveBeenCalledOnce();
  expect(unauthorized).toHaveBeenCalledOnce();
  expect(signedOut).not.toHaveBeenCalled();
});
