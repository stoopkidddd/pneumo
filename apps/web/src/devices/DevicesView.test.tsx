// @vitest-environment jsdom
import type { DeviceDTO } from "@pneumo/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { createApiClient } from "../api/client.js";
import type { HomeState } from "../home/useHome.js";
import type { Session } from "../session/store.js";
import { DevicesView } from "./DevicesView.js";

const browser: DeviceDTO = {
  id: "019a3598-c400-7000-8000-000000000001",
  name: "Office browser",
  platform: "web",
  createdAt: "2026-10-31T12:00:00.000Z",
  lastSeenAt: "2026-10-31T12:00:00.000Z",
  online: true,
};
const phone: DeviceDTO = {
  ...browser,
  id: "019a3598-c400-7000-8000-000000000002",
  name: "Pocket phone",
  platform: "android",
  createdAt: "2026-10-31T11:00:00.000Z",
  online: false,
};
const session: Session = {
  deviceId: browser.id,
  token: "fixed-fake-device-token",
  mk: new Uint8Array(32),
  contentKey: {} as CryptoKey,
};

function renderDevices() {
  const removeDevice = vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined);
  const onRemoveSelf = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const api = createApiClient({ onUnauthorized: vi.fn() });
  const state: HomeState = {
    items: [],
    devices: [phone, browser],
    lastAddedDevice: null,
    maxEnvelopeBytes: 65536,
    loading: false,
    loadingMore: false,
    nextBefore: null,
    error: null,
    live: "connected",
    offline: false,
    retry: vi.fn(),
    more: vi.fn(),
    send: vi.fn(),
    remove: vi.fn(),
    find: vi.fn(),
    renameDevice: vi.fn(),
    removeDevice,
  };
  render(<DevicesView api={api} session={session} state={state} onRemoveSelf={onRemoveSelf} />);
  return { removeDevice, onRemoveSelf };
}

afterEach(cleanup);

test("the current browser comes first even when another device was created earlier", () => {
  renderDevices();
  const rows = screen.getAllByRole("listitem");
  expect(rows[0]).toBe(screen.getByRole("listitem", { name: browser.name }));
  expect(rows[1]).toBe(screen.getByRole("listitem", { name: phone.name }));
});

test("cancelling removal keeps the device and returns focus without revoking it", () => {
  const { removeDevice, onRemoveSelf } = renderDevices();
  const row = screen.getByRole("listitem", { name: phone.name });
  const remove = within(row).getByRole("button", { name: "Remove" });
  fireEvent.click(remove);
  const confirm = within(row).getByRole("button", { name: "Remove device" });
  expect(document.activeElement).toBe(confirm);
  expect(removeDevice).not.toHaveBeenCalled();

  fireEvent.click(within(row).getByRole("button", { name: "Cancel" }));
  expect(within(row).queryByRole("button", { name: "Remove device" })).toBeNull();
  expect(screen.getByRole("listitem", { name: phone.name })).toBe(row);
  expect(document.activeElement).toBe(remove);
  expect(removeDevice).not.toHaveBeenCalled();
  expect(onRemoveSelf).not.toHaveBeenCalled();
});

test("a failed removal keeps the row, shows its error, and re-enables confirmation controls", async () => {
  const { removeDevice, onRemoveSelf } = renderDevices();
  const removal = Promise.withResolvers<void>();
  removeDevice.mockReturnValueOnce(removal.promise);
  const row = screen.getByRole("listitem", { name: phone.name });
  fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
  const confirm = within(row).getByRole("button", {
    name: "Remove device",
  }) as HTMLButtonElement;
  const cancel = within(row).getByRole("button", {
    name: "Cancel",
  }) as HTMLButtonElement;
  fireEvent.click(confirm);
  expect(confirm.disabled).toBe(true);
  expect(cancel.disabled).toBe(true);
  expect(removeDevice).toHaveBeenCalledWith(phone.id);
  expect(onRemoveSelf).not.toHaveBeenCalled();

  await act(async () => removal.reject(new TypeError("Offline")));
  expect(await within(row).findByRole("alert")).not.toBeNull();
  expect(screen.getByRole("listitem", { name: phone.name })).toBe(row);
  expect(confirm.disabled).toBe(false);
  expect(cancel.disabled).toBe(false);
  fireEvent.click(cancel);
  expect(within(row).queryByRole("alert")).toBeNull();
  expect(within(row).queryByRole("button", { name: "Remove device" })).toBeNull();
});

test("confirming removal of this browser signs out instead of removing another device", async () => {
  const { removeDevice, onRemoveSelf } = renderDevices();
  const row = screen.getByRole("listitem", { name: browser.name });
  fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
  fireEvent.click(within(row).getByRole("button", { name: "Remove device" }));
  await waitFor(() => expect(onRemoveSelf).toHaveBeenCalledOnce());
  expect(removeDevice).not.toHaveBeenCalled();
});
