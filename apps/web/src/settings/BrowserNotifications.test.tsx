// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createApiClient } from "../api/client.js";
import { NotificationPrompt } from "../pwa/NotificationPrompt.js";
import { BrowserNotifications } from "./BrowserNotifications.js";

vi.mock("../session/store.js", () => ({ load: async () => ({ token: "A".repeat(43) }) }));

const fetchMock = vi.fn<typeof fetch>();
let permission: NotificationPermission;
let subscribed: boolean;
let permissionResult: NotificationPermission;
const unsubscribe = vi.fn(async () => {
  subscribed = false;
  return true;
});
const subscription = {
  unsubscribe,
  toJSON: () => ({
    endpoint: "https://push.example.test/fake-subscription",
    keys: { p256dh: "A".repeat(87), auth: "A".repeat(22) },
  }),
};
const registration = {
  pushManager: {
    getSubscription: async () => (subscribed ? subscription : null),
    subscribe: vi.fn(async () => {
      subscribed = true;
      return subscription;
    }),
  },
};
const api = createApiClient({ onUnauthorized: async () => undefined });

beforeEach(() => {
  permission = "default";
  permissionResult = "granted";
  subscribed = false;
  localStorage.clear();
  unsubscribe.mockClear();
  registration.pushManager.subscribe.mockClear();
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("PushManager", class {});
  vi.stubGlobal("Notification", {
    get permission() {
      return permission;
    },
    requestPermission: async () => {
      permission = permissionResult;
      return permission;
    },
  });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      getRegistration: async () => registration,
      ready: Promise.resolve(registration),
    },
  });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) =>
    input === "/api/me"
      ? Response.json({
          device: {
            id: "019a3598-c400-7000-8000-000000000001",
            name: "Test browser",
            platform: "web",
            createdAt: "2026-10-31T00:00:00.000Z",
            lastSeenAt: "2026-10-31T00:00:00.000Z",
            online: false,
          },
          keyCheck: "A".repeat(43),
          limits: { maxFileBytes: 500, maxEnvelopeBytes: 65536 },
          vapidPublicKey: "A".repeat(87),
          uploadMode: "direct",
        })
      : new Response(null, { status: 204 }),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, "serviceWorker");
  vi.unstubAllGlobals();
});

async function readySwitch() {
  const control = await screen.findByRole("switch", { name: "Browser notifications" });
  await waitFor(() => expect((control as HTMLButtonElement).disabled).toBe(false));
  return control;
}

test("permission denial leaves notifications off and explains how to unblock them", async () => {
  permissionResult = "denied";
  render(<BrowserNotifications api={api} />);
  fireEvent.click(await readySwitch());
  await screen.findByText(/Notifications are blocked/);
  expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
  expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
});

test("failed storage rolls back a new browser subscription and allows a successful retry", async () => {
  fetchMock.mockImplementationOnce(async () => {
    throw new TypeError("Offline");
  });
  render(<BrowserNotifications api={api} />);
  fireEvent.click(await readySwitch());
  await screen.findByRole("alert");
  expect(subscribed).toBe(false);
  const control = await readySwitch();
  fireEvent.click(control);
  await screen.findByText(/Enabled\. New pushes/);
  expect(control.getAttribute("aria-checked")).toBe("true");
});

test("rejected subscription persistence does not leave an unregistered push subscription", async () => {
  const success = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (input, init) => {
    if (init?.method === "PUT") throw new TypeError("Offline");
    if (!success) throw new Error("Missing test handler");
    return success(input, init);
  });
  render(<BrowserNotifications api={api} />);
  fireEvent.click(await readySwitch());
  await screen.findByRole("alert");
  expect(subscribed).toBe(false);
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
});

test("failed disable keeps the working subscription enabled and permits retry", async () => {
  permission = "granted";
  subscribed = true;
  fetchMock.mockRejectedValueOnce(new TypeError("Offline"));
  render(<BrowserNotifications api={api} />);
  const control = await readySwitch();
  fireEvent.click(control);
  await screen.findByRole("alert");
  expect(subscribed).toBe(true);
  expect(control.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(control);
  await screen.findByText(/Off\. Enable/);
  expect(subscribed).toBe(false);
});

test("unsupported browsers show an explicit disabled state", async () => {
  vi.stubGlobal("isSecureContext", false);
  render(<BrowserNotifications api={api} />);
  expect(screen.getByText(/Browser notifications are not supported/)).toBeTruthy();
  expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
});

test("the Home prompt stays dismissed across remounts", async () => {
  const view = render(<NotificationPrompt api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
  view.unmount();
  render(<NotificationPrompt api={api} />);
  await act(async () => undefined);
  expect(screen.queryByRole("heading", { name: "Get notified in this browser" })).toBeNull();
});
