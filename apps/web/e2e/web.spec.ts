import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, login, PASSPHRASE, test } from "./fixtures.js";
import { SETUP_TOKEN } from "./runtime.js";

const screenshotDirectory = fileURLToPath(new URL("../test-results/screens", import.meta.url));

async function assertAccessible(page: Page): Promise<void> {
  const scan = await new AxeBuilder({ page }).analyze();
  expect(scan.violations).toEqual([]);
}

async function captureView(
  page: Page,
  name: string,
  options: { mobile?: boolean } = {},
): Promise<void> {
  await mkdir(screenshotDirectory, { recursive: true });
  await page.evaluate(async () => {
    await document.fonts.ready;
    document.getElementById("main")?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  });
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.screenshot({
      path: join(screenshotDirectory, `${name}-${colorScheme}.png`),
      fullPage: true,
      animations: "disabled",
    });
  }
  if (options.mobile) {
    const desktopViewport = page.viewportSize();
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: join(screenshotDirectory, `${name}-mobile.png`),
      fullPage: true,
      animations: "disabled",
    });
    if (desktopViewport) await page.setViewportSize(desktopViewport);
  }
  await page.emulateMedia({ colorScheme: null });
}

type KeyProbe = { iv: number[]; ciphertext: number[] };

async function storedSession(
  page: Page,
  previousProbe?: KeyProbe,
): Promise<{
  count: number;
  token?: string;
  deviceId?: string;
  usableContentKey?: boolean;
  nonExtractableContentKey?: boolean;
  probe?: KeyProbe;
}> {
  return page.evaluate(async (previousProbe) => {
    const databases = await indexedDB.databases();
    if (!databases.some((database) => database.name === "pneumo")) return { count: 0 };
    const opened = Promise.withResolvers<IDBDatabase>();
    const openRequest = indexedDB.open("pneumo");
    openRequest.onerror = () => opened.reject(openRequest.error);
    openRequest.onsuccess = () => opened.resolve(openRequest.result);
    const database = await opened.promise;
    try {
      if (!database.objectStoreNames.contains("session")) return { count: 0 };
      const loaded = Promise.withResolvers<unknown[]>();
      const transaction = database.transaction("session", "readonly");
      const loadRequest = transaction.objectStore("session").getAll();
      loadRequest.onerror = () => loaded.reject(loadRequest.error);
      loadRequest.onsuccess = () => loaded.resolve(loadRequest.result);
      const records = await loaded.promise;
      const session = records[0] as
        | { token?: unknown; deviceId?: unknown; contentKey?: unknown }
        | undefined;
      if (!session) return { count: 0 };
      const contentKey = session.contentKey;
      let usableContentKey = false;
      let nonExtractableContentKey = false;
      let probe = previousProbe;
      if (contentKey instanceof CryptoKey) {
        const iv = probe ? new Uint8Array(probe.iv) : crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = probe
          ? new Uint8Array(probe.ciphertext)
          : new Uint8Array(
              await crypto.subtle.encrypt(
                { name: "AES-GCM", iv },
                contentKey,
                new Uint8Array([1, 2, 3]),
              ),
            );
        const plaintext = new Uint8Array(
          await crypto.subtle.decrypt({ name: "AES-GCM", iv }, contentKey, ciphertext),
        );
        usableContentKey =
          plaintext.length === 3 && plaintext.every((value, index) => value === index + 1);
        probe = { iv: Array.from(iv), ciphertext: Array.from(ciphertext) };
        try {
          await crypto.subtle.exportKey("raw", contentKey);
        } catch (error) {
          nonExtractableContentKey =
            error instanceof DOMException && error.name === "InvalidAccessError";
        }
      }
      return {
        count: records.length,
        ...(typeof session.token === "string" ? { token: session.token } : {}),
        ...(typeof session.deviceId === "string" ? { deviceId: session.deviceId } : {}),
        usableContentKey,
        nonExtractableContentKey,
        ...(probe ? { probe } : {}),
      };
    } finally {
      database.close();
    }
  }, previousProbe);
}

function requireSessionValue(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Stored session is missing ${label}`);
  return value;
}

test("setup acknowledgment opens the accessible application shell", async ({ page, instance }) => {
  await page.goto(`${instance.origin}/setup#token=${encodeURIComponent(SETUP_TOKEN)}`);
  await expect(page.getByRole("heading", { name: "Set up Pneumo" })).toBeVisible();
  await assertAccessible(page);
  await captureView(page, "setup", { mobile: true });

  const passphrase = page.getByLabel("Passphrase", { exact: true });
  await expect(passphrase).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "Show passphrase" }).click();
  await expect(passphrase).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "Hide passphrase" }).click();

  await passphrase.fill(PASSPHRASE);
  await page.getByLabel("Repeat passphrase", { exact: true }).fill(PASSPHRASE);
  await page.getByLabel("Device name", { exact: true }).fill("Owner browser");
  await page.getByRole("button", { name: "Create instance" }).click();

  await expect(page.getByRole("heading", { name: "Keep your passphrase safe" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue to Home" })).toBeDisabled();
  await assertAccessible(page);
  await captureView(page, "warning");
  await page
    .getByRole("checkbox", {
      name: "I understand that my history cannot be recovered without my passphrase",
    })
    .check();
  await page.getByRole("button", { name: "Continue to Home" }).click();

  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
  await assertAccessible(page);
  await captureView(page, "home");

  await page.getByText("Devices", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible();
  await assertAccessible(page);
  await captureView(page, "devices");

  await page.getByText("Settings", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByLabel("Device name", { exact: true })).toHaveAttribute("readonly", "");
  await assertAccessible(page);
  await captureView(page, "settings");
});

test("a second independent browser signs in", async ({ browser, instance, signedIn }) => {
  await expect(signedIn.page.getByRole("heading", { name: "Home" })).toBeVisible();
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(instance.origin);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await assertAccessible(page);
    await captureView(page, "login", { mobile: true });
    await page.getByLabel("Passphrase", { exact: true }).fill(PASSPHRASE);
    await page.getByLabel("Device name", { exact: true }).fill("Second browser");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("reload restores a usable nonextractable content key", async ({ signedIn }) => {
  const beforeReload = await storedSession(signedIn.page);
  expect(beforeReload.count).toBe(1);
  expect(beforeReload.usableContentKey).toBe(true);
  expect(beforeReload.nonExtractableContentKey).toBe(true);

  await signedIn.page.reload();
  await expect(signedIn.page.getByRole("heading", { name: "Home" })).toBeVisible();
  const afterReload = await storedSession(signedIn.page, beforeReload.probe);
  expect(afterReload.count).toBe(1);
  expect(afterReload.usableContentKey).toBe(true);
  expect(afterReload.nonExtractableContentKey).toBe(true);
});

test("sign out revokes the device, clears IndexedDB, and permits login", async ({
  instance,
  request,
  signedIn,
}) => {
  const session = await storedSession(signedIn.page);
  const token = requireSessionValue(session.token, "token");
  await signedIn.page.getByText("Settings", { exact: true }).click();
  await signedIn.page.getByRole("button", { name: "Sign out" }).click();
  await expect(signedIn.page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  expect((await storedSession(signedIn.page)).count).toBe(0);

  const revoked = await request.get(`${instance.origin}/api/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(revoked.status()).toBe(401);

  await signedIn.page.getByLabel("Passphrase", { exact: true }).fill(PASSPHRASE);
  await signedIn.page.getByLabel("Device name", { exact: true }).fill("Signed in again");
  await signedIn.page.getByRole("button", { name: "Sign in" }).click();
  await expect(signedIn.page.getByRole("heading", { name: "Home" })).toBeVisible();
});

test("wrong passphrase stays on login with a local error", async ({
  browser,
  instance,
  signedIn,
}) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await login(page, instance.origin, {
      passphrase: "this passphrase is wrong",
      deviceName: "Wrong browser",
    });
    await expect(page.getByText("Wrong passphrase", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  } finally {
    await context.close();
  }
  await expect(signedIn.page.getByRole("heading", { name: "Home" })).toBeVisible();
});

test("setup without a token fragment is rejected", async ({ page }) => {
  const origin = process.env.PNEUMO_E2E_ORIGIN;
  if (!origin) throw new Error("Global setup did not start the web server");
  await page.goto(`${origin}/setup`);
  await expect(page.getByRole("heading", { name: "Set up Pneumo" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(/token/i);
  await expect(page.getByRole("button", { name: "Create instance" })).toHaveCount(0);
  await assertAccessible(page);
  await captureView(page, "setup-missing-token", { mobile: true });
});

test("login rate limiting reports retry time in minutes", async ({
  browser,
  instance,
  request,
  signedIn,
}) => {
  const invalidLogin = {
    authKey: "A".repeat(43),
    device: { name: "Rate limited browser", platform: "web" },
  };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await request.post(`${instance.origin}/api/auth/login`, {
      data: invalidLogin,
    });
    expect(response.status()).toBe(401);
  }

  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await login(page, instance.origin, {
      passphrase: "another wrong passphrase",
      deviceName: "Rate limited browser",
    });
    await expect(page.getByText(/^Too many attempts\. Try again in \d+ minutes$/)).toBeVisible();
  } finally {
    await context.close();
  }
  await expect(signedIn.page.getByRole("heading", { name: "Home" })).toBeVisible();
});

test("server-side device revocation signs out an unauthorized browser", async ({
  browser,
  instance,
  request,
  signedIn,
}) => {
  const owner = await storedSession(signedIn.page);
  const ownerToken = requireSessionValue(owner.token, "owner token");
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await login(page, instance.origin, { deviceName: "Revoked browser" });
    await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
    const revokedSession = await storedSession(page);
    const revokedDeviceId = requireSessionValue(revokedSession.deviceId, "device id");

    const removal = await request.delete(`${instance.origin}/api/devices/${revokedDeviceId}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(removal.status()).toBe(204);

    await page.reload();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    expect((await storedSession(page)).count).toBe(0);
  } finally {
    await context.close();
  }
});

test("internal navigation preserves the document and browser history", async ({ signedIn }) => {
  const { page } = signedIn;
  let documentLoads = 0;
  page.on("load", () => {
    documentLoads += 1;
  });
  await page.evaluate(() => {
    Reflect.set(window, "pneumoNavigationMarker", true);
  });

  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await page.getByRole("link", { name: "Pneumo home" }).click();
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  expect(await page.evaluate(() => Reflect.get(window, "pneumoNavigationMarker"))).toBe(true);
  expect(documentLoads).toBe(0);
});

test("connection unavailable is accessible and retry reconnects", async ({ page, instance }) => {
  await page.route("**/api/health", (route) => route.abort());
  await page.goto(instance.origin);
  await expect(page.getByRole("heading", { name: "Connection unavailable" })).toBeVisible();
  await assertAccessible(page);
  await captureView(page, "connection-unavailable");
  await page.unroute("**/api/health");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Set up Pneumo" })).toBeVisible();
});
