import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { type BrowserContext, chromium, type Page, type Worker } from "@playwright/test";
import { deriveKeys, deriveMasterKey, encryptPush } from "@pneumo/crypto";
import {
  AuthParamsResponse,
  PushDTO,
  type PushPayload,
  uuidv7,
  type WebPushPayload,
} from "@pneumo/protocol";
import { test as base, completeSetup, expect, login, PASSPHRASE } from "./fixtures.js";

async function persistentBrowser() {
  const directory = await mkdtemp(join(tmpdir(), "pneumo-pwa-"));
  try {
    const context = await chromium.launchPersistentContext(directory, {
      channel: "chromium",
      // Use Chromium's notification backend, not the headless host's OS notification center.
      args: ["--disable-features=NativeNotifications"],
    });
    return {
      context,
      stop: async () => {
        try {
          await context.close();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    };
  } catch (failure) {
    await rm(directory, { recursive: true, force: true });
    throw failure;
  }
}

// Full Chromium and a non-incognito profile are required for native push and installability.
const test = base.extend({
  signedIn: async ({ instance }, use) => {
    const browser = await persistentBrowser();
    const page = await browser.context.newPage();
    const deviceName = "Owner browser";
    try {
      await completeSetup(page, instance.origin, { deviceName });
      await use({ context: browser.context, page, passphrase: PASSPHRASE, deviceName });
    } finally {
      await browser.stop();
    }
  },
});

const screenshotDirectory = fileURLToPath(new URL("../test-results/screens", import.meta.url));

type ManifestIcon = {
  src: string;
  sizes: string;
  type?: string;
  purpose?: string;
};

type WebManifest = {
  name?: unknown;
  short_name?: unknown;
  start_url?: unknown;
  display?: unknown;
  icons?: unknown;
};

type NotificationCaptureName =
  | "home-notification-prompt"
  | "settings-notifications-off"
  | "settings-notifications-on"
  | "settings-notifications-denied"
  | "settings-notifications-unsupported";

async function captureAccessibleSettings(page: Page, name: NotificationCaptureName): Promise<void> {
  await mkdir(screenshotDirectory, { recursive: true });
  await page.evaluate(async () => {
    await document.fonts.ready;
    document.getElementById("main")?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  });

  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    const scan = await new AxeBuilder({ page }).analyze();
    expect(scan.violations).toEqual([]);
    await page.screenshot({
      path: join(screenshotDirectory, `${name}-${colorScheme}.png`),
      fullPage: true,
      animations: "disabled",
    });
  }

  const desktopViewport = page.viewportSize();
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileScan = await new AxeBuilder({ page }).analyze();
  expect(mobileScan.violations).toEqual([]);
  await page.screenshot({
    path: join(screenshotDirectory, `${name}-mobile.png`),
    fullPage: true,
    animations: "disabled",
  });
  if (desktopViewport) await page.setViewportSize(desktopViewport);
  await page.emulateMedia({ colorScheme: null });
}

async function deviceIdFromStoredSession(page: Page): Promise<string> {
  const deviceId = await page.evaluate(async () => {
    const opened = Promise.withResolvers<IDBDatabase>();
    const request = indexedDB.open("pneumo");
    request.onerror = () => opened.reject(request.error);
    request.onsuccess = () => opened.resolve(request.result);
    const database = await opened.promise;
    try {
      const loaded = Promise.withResolvers<unknown>();
      const transaction = database.transaction("session", "readonly");
      const get = transaction.objectStore("session").get("current");
      get.onerror = () => loaded.reject(get.error);
      get.onsuccess = () => loaded.resolve(get.result);
      const session = await loaded.promise;
      if (
        typeof session !== "object" ||
        session === null ||
        typeof Reflect.get(session, "deviceId") !== "string"
      ) {
        throw new Error("The signed-in test session has no device id");
      }
      return Reflect.get(session, "deviceId") as string;
    } finally {
      database.close();
    }
  });
  return deviceId;
}

async function deriveSessionContentKey(page: Page): Promise<CryptoKey> {
  const response = await page.request.get(new URL("/api/auth/params", page.url()).href);
  expect(response.ok()).toBe(true);
  const params = AuthParamsResponse.parse(await response.json());
  const mk = await deriveMasterKey(PASSPHRASE, params.kdf);
  try {
    return (await deriveKeys(mk)).contentKey;
  } finally {
    mk.fill(0);
  }
}

async function createEncryptedPush(
  page: Page,
  contentKey: CryptoKey,
  payload: PushPayload,
): Promise<PushDTO> {
  const id = uuidv7();
  const envelope = await encryptPush(contentKey, id, payload);
  const result = await page.evaluate(
    async (record) => {
      const opened = Promise.withResolvers<IDBDatabase>();
      const request = indexedDB.open("pneumo");
      request.onerror = () => opened.reject(request.error);
      request.onsuccess = () => opened.resolve(request.result);
      const database = await opened.promise;
      let token: string;
      try {
        const loaded = Promise.withResolvers<unknown>();
        const transaction = database.transaction("session", "readonly");
        const get = transaction.objectStore("session").get("current");
        get.onerror = () => loaded.reject(get.error);
        get.onsuccess = () => loaded.resolve(get.result);
        const session = await loaded.promise;
        if (
          typeof session !== "object" ||
          session === null ||
          typeof Reflect.get(session, "token") !== "string"
        ) {
          throw new Error("A signed-in test session is required");
        }
        token = Reflect.get(session, "token") as string;
      } finally {
        database.close();
      }
      const response = await fetch("/api/pushes", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(record),
      });
      if (!response.ok) throw new Error(`Could not create the test push: HTTP ${response.status}`);
      return response.json() as Promise<unknown>;
    },
    { id, targetDeviceId: null, envelope, file: null },
  );
  return PushDTO.parse(result);
}

async function activeWorker(context: BrowserContext): Promise<Worker> {
  await expect.poll(() => context.serviceWorkers().length).toBeGreaterThan(0);
  const worker = context
    .serviceWorkers()
    .find((candidate) => new URL(candidate.url()).pathname === "/sw.js");
  if (!worker) throw new Error("The Pneumo service worker is not active");
  return worker;
}

async function handlePush(worker: Worker, payload: WebPushPayload): Promise<void> {
  await worker.evaluate(async (value) => {
    const candidate = Reflect.get(globalThis, "handlePush");
    if (typeof candidate !== "function") {
      throw new Error("The service worker does not expose handlePush");
    }
    await candidate(value);
  }, payload);
}

async function waitForNotification(worker: Worker, tag: string): Promise<void> {
  // Native notification persistence can complete after showNotification resolves.
  await expect
    .poll(() =>
      worker.evaluate(async (notificationTag) => {
        const registration = Reflect.get(globalThis, "registration") as ServiceWorkerRegistration;
        return (await registration.getNotifications({ tag: notificationTag })).length;
      }, tag),
    )
    .toBe(1);
}

async function notificationDetails(
  worker: Worker,
  tag: string,
): Promise<{ title: string; body: string; actionNames: string[] }> {
  await waitForNotification(worker, tag);
  return worker.evaluate(async (notificationTag) => {
    const registration = Reflect.get(globalThis, "registration") as {
      getNotifications(options: { tag: string }): Promise<Notification[]>;
    };
    const notifications = await registration.getNotifications({ tag: notificationTag });
    if (notifications.length !== 1 || !notifications[0]) {
      throw new Error("Expected one notification for the test push");
    }
    const notification = notifications[0] as Notification & {
      readonly actions: readonly { action: string }[];
    };
    return {
      title: notification.title,
      body: notification.body,
      actionNames: notification.actions.map(({ action }) => action),
    };
  }, tag);
}

async function dispatchNotificationClick(
  worker: Worker,
  tag: string,
  action = "",
  captureOpenWindow = false,
): Promise<string | null> {
  await waitForNotification(worker, tag);
  return worker.evaluate(
    async ({ notificationTag, notificationAction, captureWindow }) => {
      const registration = Reflect.get(globalThis, "registration") as {
        getNotifications(options: { tag: string }): Promise<Notification[]>;
      };
      const notifications = await registration.getNotifications({ tag: notificationTag });
      if (notifications.length !== 1 || !notifications[0]) {
        throw new Error("Expected one notification to dispatch");
      }
      const workerClients = Reflect.get(globalThis, "clients") as {
        openWindow(url: string): Promise<unknown>;
      };
      const originalOpenWindow = workerClients.openWindow;
      // Synthetic events have no native notification user activation; message delivery stays real.
      const windowClientPrototype = Reflect.get(globalThis, "WindowClient").prototype as {
        focus(): Promise<unknown>;
      };
      const originalFocus = windowClientPrototype.focus;
      windowClientPrototype.focus = async function () {
        return this;
      };
      let openedUrl: string | null = null;
      if (captureWindow) {
        workerClients.openWindow = async (url) => {
          openedUrl = url;
          return null;
        };
      }
      try {
        let lifetime: Promise<unknown> | undefined;
        const event = new Event("notificationclick");
        Object.defineProperties(event, {
          action: { value: notificationAction },
          notification: { value: notifications[0] },
          waitUntil: {
            value: (promise: Promise<unknown>) => {
              lifetime = Promise.resolve(promise);
            },
          },
        });
        globalThis.dispatchEvent(event);
        await lifetime;
        return openedUrl;
      } finally {
        windowClientPrototype.focus = originalFocus;
        if (captureWindow) workerClients.openWindow = originalOpenWindow;
      }
    },
    {
      notificationTag: tag,
      notificationAction: action,
      captureWindow: captureOpenWindow,
    },
  );
}

test("manifest assets are decodable, the worker controls reloads, and Chromium reports installable", async ({
  instance,
  signedIn,
}) => {
  const { context, page } = signedIn;
  const response = await page.request.get(`${instance.origin}/manifest.webmanifest`);
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toContain("application/manifest+json");
  const manifest = (await response.json()) as WebManifest;
  expect(manifest.name).toBe("Pneumo");
  expect(manifest.short_name).toBe("Pneumo");
  expect(manifest.start_url).toBe("/");
  expect(manifest.display).toBe("standalone");
  expect(Array.isArray(manifest.icons)).toBe(true);
  const icons = manifest.icons as ManifestIcon[];
  expect(icons.length).toBeGreaterThanOrEqual(3);
  expect(icons.some(({ purpose }) => purpose?.split(/\s+/).includes("maskable"))).toBe(true);

  for (const icon of icons) {
    const declaredSize = /^(\d+)x(\d+)$/.exec(icon.sizes);
    expect(declaredSize).not.toBeNull();
    if (!declaredSize) continue;
    const decoded = await page.evaluate(async (src) => {
      const imageResponse = await fetch(src);
      if (!imageResponse.ok) throw new Error(`Icon request failed: HTTP ${imageResponse.status}`);
      const bitmap = await createImageBitmap(await imageResponse.blob());
      try {
        return { width: bitmap.width, height: bitmap.height };
      } finally {
        bitmap.close();
      }
    }, icon.src);
    expect(decoded.width).toBe(Number(declaredSize[1]));
    expect(decoded.height).toBe(Number(declaredSize[2]));
  }

  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
  expect(
    await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL.endsWith("/sw.js")),
  ).toBe(true);
  await activeWorker(context);

  const cdp = await context.newCDPSession(page);
  const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
  console.log(JSON.stringify({ installabilityErrors }));
  expect(installabilityErrors).toEqual([]);
});

test("the service worker decrypts inline and reference pushes and routes notification clicks", async ({
  instance,
  signedIn,
}) => {
  const { context, page } = signedIn;
  await context.grantPermissions(["notifications"], { origin: instance.origin });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  const toggle = page.getByRole("switch", { name: "Browser notifications" });
  await toggle.click();
  await expect(toggle).toBeChecked();
  await page.getByRole("link", { name: "Home", exact: true }).click();
  const worker = await activeWorker(context);
  const contentKey = await deriveSessionContentKey(page);
  const notePayload: PushPayload = {
    type: "note",
    title: "Dispatch received",
    body: "The capsule reached this browser.",
  };
  const linkPayload: PushPayload = {
    type: "link",
    title: "Open browser settings",
    body: "Review notification preferences.",
    url: `${instance.origin}/settings`,
  };
  const note = await createEncryptedPush(page, contentKey, notePayload);
  const link = await createEncryptedPush(page, contentKey, linkPayload);

  // Keep Chromium running on its neutral startup tab, with every Pneumo tab closed.
  await Promise.all(
    context
      .pages()
      .filter((candidate) => candidate.url().startsWith(instance.origin))
      .map((candidate) => candidate.close()),
  );
  expect(
    await worker.evaluate(async () => {
      const clients = Reflect.get(globalThis, "clients") as {
        matchAll(options: { type: "window" }): Promise<unknown[]>;
      };
      return (await clients.matchAll({ type: "window" })).length;
    }),
  ).toBe(0);

  await handlePush(worker, { t: "push", push: note });
  expect(await notificationDetails(worker, note.id)).toEqual({
    title: notePayload.title,
    body: notePayload.body,
    actionNames: [],
  });

  await handlePush(worker, { t: "ref", id: link.id });
  expect(await notificationDetails(worker, link.id)).toEqual({
    title: linkPayload.title,
    body: linkPayload.body,
    actionNames: ["open"],
  });

  const defaultRoute = await dispatchNotificationClick(worker, note.id, "", true);
  expect(new URL(defaultRoute ?? "/", instance.origin).href).toBe(
    `${instance.origin}/?push=${note.id}`,
  );
  const routedPage = await context.newPage();
  await routedPage.goto(new URL(defaultRoute ?? "/", instance.origin).href);
  await expect(routedPage).toHaveURL(new RegExp(`\\?push=${note.id}$`));
  const noteRow = routedPage.locator(`article[data-push-id="${note.id}"]`);
  await expect(noteRow).toBeVisible();
  await expect(noteRow.getByRole("button", { name: "Copy" })).toBeFocused();

  await routedPage.goto(instance.origin);
  await expect(routedPage.getByRole("heading", { name: "Home" })).toBeVisible();
  await handlePush(worker, { t: "push", push: note });
  await dispatchNotificationClick(worker, note.id);
  await expect(routedPage).toHaveURL(new RegExp(`\\?push=${note.id}$`));
  await expect(noteRow.getByRole("button", { name: "Copy" })).toBeFocused();

  const linkRoute = await dispatchNotificationClick(worker, link.id, "open", true);
  expect(linkRoute).toBe(linkPayload.url);

  await Promise.all(
    context
      .pages()
      .filter((candidate) => candidate.url().startsWith(instance.origin))
      .map((candidate) => candidate.close()),
  );
  await worker.evaluate(async () => {
    const deleted = Promise.withResolvers<void>();
    const request = indexedDB.deleteDatabase("pneumo");
    request.onerror = () => deleted.reject(request.error);
    request.onsuccess = () => deleted.resolve();
    request.onblocked = () => deleted.reject(new Error("The session database is still open"));
    await deleted.promise;
  });
  await handlePush(worker, { t: "push", push: note });
  await expect
    .poll(async () => (await notificationDetails(worker, note.id)).title)
    .toBe("New push");
});

test("notification settings persist subscribe and unsubscribe and expose accessible states", async ({
  instance,
  signedIn,
}) => {
  const { context, page } = signedIn;
  await context.grantPermissions(["notifications"], { origin: instance.origin });
  await page.reload();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  const toggle = page.getByRole("switch", { name: "Browser notifications" });
  await expect(toggle).not.toBeChecked();
  await expect(page.getByText("Off", { exact: true })).toBeVisible();
  await captureAccessibleSettings(page, "settings-notifications-off");

  const deviceId = await deviceIdFromStoredSession(page);
  const subscribed = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "PUT" &&
      new URL(candidate.url()).pathname === "/api/devices/self/webpush" &&
      candidate.status() === 204,
  );
  await toggle.click();
  await subscribed;
  await expect(toggle).toBeChecked();
  await expect(page.getByText("On", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Enabled. New pushes will appear as browser notifications.", { exact: true }),
  ).toBeVisible();
  expect(await instance.readDeviceHasWebPush(deviceId)).toBe(true);
  await captureAccessibleSettings(page, "settings-notifications-on");

  const unsubscribed = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "DELETE" &&
      new URL(candidate.url()).pathname === "/api/devices/self/webpush" &&
      candidate.status() === 204,
  );
  await toggle.click();
  await unsubscribed;
  await expect(toggle).not.toBeChecked();
  expect(await instance.readDeviceHasWebPush(deviceId)).toBe(false);

  await context.clearPermissions();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Browser.setPermission", {
    permission: { name: "notifications" },
    setting: "denied",
    origin: instance.origin,
  });
  await page.reload();
  await expect(
    page.getByText(
      "Notifications are blocked. Allow notifications in your browser’s site settings, then return here.",
      { exact: true },
    ),
  ).toBeVisible();
  await captureAccessibleSettings(page, "settings-notifications-denied");

  await page.addInitScript(() => {
    Reflect.deleteProperty(globalThis, "Notification");
  });
  await page.reload();
  await expect(
    page.getByText("Browser notifications are not supported", { exact: false }),
  ).toBeVisible();
  await captureAccessibleSettings(page, "settings-notifications-unsupported");
});

test("the Home notification prompt can be dismissed once or used to enable notifications", async ({
  instance,
  signedIn,
}) => {
  const { page } = signedIn;
  const prompt = page.getByText("Get notified in this browser", { exact: true });
  await expect(prompt).toBeVisible();
  await captureAccessibleSettings(page, "home-notification-prompt");
  await page.getByRole("button", { name: "Not now", exact: true }).click();
  await expect(prompt).not.toBeVisible();
  await page.reload();
  await expect(prompt).not.toBeVisible();

  const browser = await persistentBrowser();
  const { context } = browser;
  const enabledPage = await context.newPage();
  try {
    await login(enabledPage, instance.origin, {
      deviceName: `Prompt browser ${randomUUID()}`,
    });
    await expect(enabledPage.getByRole("heading", { name: "Home" })).toBeVisible();
    const enabledPrompt = enabledPage.getByText("Get notified in this browser", { exact: true });
    await expect(enabledPrompt).toBeVisible();
    await context.grantPermissions(["notifications"], { origin: instance.origin });
    const subscribed = enabledPage.waitForResponse(
      (candidate) =>
        candidate.request().method() === "PUT" &&
        new URL(candidate.url()).pathname === "/api/devices/self/webpush" &&
        candidate.status() === 204,
    );
    await enabledPage.getByRole("button", { name: "Enable notifications", exact: true }).click();
    await subscribed;
    await expect(enabledPrompt).not.toBeVisible();
  } finally {
    await browser.stop();
  }
});

test("signing out also removes this browser’s notification subscription", async ({ signedIn }) => {
  const { context, page } = signedIn;
  await context.grantPermissions(["notifications"], { origin: new URL(page.url()).origin });
  await page.reload();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  const toggle = page.getByRole("switch", { name: "Browser notifications" });
  await toggle.click();
  await expect(toggle).toBeChecked();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  expect(
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return (await registration?.pushManager.getSubscription()) === null;
    }),
  ).toBe(true);
});

test("the installed worker keeps the signed-in Home shell available after an offline reload", async ({
  signedIn,
}) => {
  const { context, page } = signedIn;
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  await context.setOffline(true);
  try {
    await page.reload();
    await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
    await expect(page.locator(".offline-banner")).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});
