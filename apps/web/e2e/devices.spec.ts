import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { parsePairingUri } from "@pneumo/crypto";
import { ClaimPairResponse } from "@pneumo/protocol";
import jsQR from "jsqr";
import { expect, login, test } from "./fixtures.js";

const screenshotDirectory = fileURLToPath(new URL("../test-results/screens", import.meta.url));

type DeviceCaptureName =
  | "devices-list"
  | "devices-rename"
  | "devices-remove-confirm"
  | "devices-revoked-login"
  | "devices-self-removed-login"
  | "devices-pairing"
  | "devices-paired"
  | "settings-device-name";

type ParsedPairing = {
  origin: string;
  code: string;
  mk: Uint8Array<ArrayBuffer>;
};

async function assertAccessibleAndCapture(
  page: Page,
  name: DeviceCaptureName,
  { keepFocus = false }: { keepFocus?: boolean } = {},
): Promise<void> {
  await mkdir(screenshotDirectory, { recursive: true });
  await page.evaluate(async (preserveFocus) => {
    await document.fonts.ready;
    if (!preserveFocus) document.getElementById("main")?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, keepFocus);

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

async function openSecondBrowser(
  browser: Browser,
  origin: string,
  deviceName: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, origin, { deviceName });
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  return { context, page };
}

function deviceRow(page: Page, name: string) {
  return page.getByRole("listitem", { name, exact: true });
}

async function storedSessionCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    if (!(await indexedDB.databases()).some((database) => database.name === "pneumo")) return 0;
    const opened = Promise.withResolvers<IDBDatabase>();
    const request = indexedDB.open("pneumo");
    request.onerror = () => opened.reject(request.error);
    request.onsuccess = () => opened.resolve(request.result);
    const database = await opened.promise;
    try {
      if (!database.objectStoreNames.contains("session")) return 0;
      const loaded = Promise.withResolvers<unknown[]>();
      const transaction = database.transaction("session", "readonly");
      const getAll = transaction.objectStore("session").getAll();
      getAll.onerror = () => loaded.reject(getAll.error);
      getAll.onsuccess = () => loaded.resolve(getAll.result);
      return (await loaded.promise).length;
    } finally {
      database.close();
    }
  });
}

async function decodePairingCanvas(page: Page): Promise<ParsedPairing> {
  const pixels = await page.getByLabel("Pairing QR code", { exact: true }).evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Pairing QR canvas has no 2D context");
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    return { width: image.width, height: image.height, data: Array.from(image.data) };
  });
  const decoded = jsQR(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height, {
    inversionAttempts: "dontInvert",
  });
  if (!decoded) throw new Error("Could not decode the pairing QR canvas");
  return parsePairingUri(decoded.data);
}

async function pairingKeyMatchesStoredSession(
  page: Page,
  pairingKey: Uint8Array,
): Promise<boolean> {
  return page.evaluate(async (expectedKey) => {
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
      const session = (await loaded.promise) as { mk?: unknown } | undefined;
      if (!(session?.mk instanceof Uint8Array) || session.mk.length !== expectedKey.length) {
        return false;
      }
      return session.mk.every((value, index) => value === expectedKey[index]);
    } finally {
      database.close();
    }
  }, Array.from(pairingKey));
}

async function openPairing(page: Page): Promise<void> {
  const response = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "POST" &&
      new URL(candidate.url()).pathname === "/api/pair" &&
      candidate.status() === 201,
  );
  await page.getByRole("button", { name: "Add a phone", exact: true }).click();
  await response;
  await expect(page.getByRole("dialog", { name: "Add a phone" })).toBeVisible();
  await expect(page.getByLabel("Pairing QR code", { exact: true })).toBeVisible();
}

test("device and Settings renames persist and update the Home target list", async ({
  browser,
  instance,
  signedIn,
}) => {
  const owner = signedIn.page;
  await expect(owner.getByText("Live", { exact: true })).toBeVisible();
  const second = await openSecondBrowser(browser, instance.origin, "Tablet browser");
  try {
    await owner.getByRole("link", { name: "Devices", exact: true }).click();
    await expect(owner.getByRole("heading", { name: "Devices" })).toBeVisible();
    await expect(deviceRow(owner, signedIn.deviceName)).toBeVisible();
    const tablet = deviceRow(owner, "Tablet browser");
    await expect(tablet).toBeVisible();
    await assertAccessibleAndCapture(owner, "devices-list");

    await tablet.getByRole("button", { name: "Rename", exact: true }).click();
    const renamedDevice = "Living room tablet";
    await tablet.getByLabel("Device name", { exact: true }).fill(renamedDevice);
    await assertAccessibleAndCapture(owner, "devices-rename", { keepFocus: true });
    await tablet.getByRole("button", { name: "Save name", exact: true }).click();
    await expect(deviceRow(owner, renamedDevice)).toBeVisible();
    await expect(deviceRow(owner, "Tablet browser")).toHaveCount(0);

    await owner.reload();
    await expect(owner.getByRole("heading", { name: "Devices" })).toBeVisible();
    await expect(deviceRow(owner, renamedDevice)).toBeVisible();
    await owner.getByRole("link", { name: "Home", exact: true }).click();
    const target = owner.getByLabel("Send to", { exact: true });
    await expect(target.locator("option").filter({ hasText: renamedDevice })).toHaveCount(1);

    await owner.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(owner.getByRole("heading", { name: "Settings" })).toBeVisible();
    const settingsName = "Desk browser";
    await owner.getByLabel("Device name", { exact: true }).fill(settingsName);
    await owner.getByRole("button", { name: "Save name", exact: true }).click();
    await expect(owner.getByLabel("Device name", { exact: true })).toHaveValue(settingsName);
    await assertAccessibleAndCapture(owner, "settings-device-name");
    await owner.reload();
    await expect(owner.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(owner.getByLabel("Device name", { exact: true })).toHaveValue(settingsName);
  } finally {
    await second.context.close();
  }
});

test("device removal can be cancelled, revokes another browser in place, and signs out self", async ({
  browser,
  instance,
  signedIn,
}) => {
  const owner = signedIn.page;
  await expect(owner.getByText("Live", { exact: true })).toBeVisible();
  const secondName = "Removable browser";
  const second = await openSecondBrowser(browser, instance.origin, secondName);
  try {
    await owner.getByRole("link", { name: "Devices", exact: true }).click();
    const secondRow = deviceRow(owner, secondName);
    await expect(secondRow).toBeVisible();

    await secondRow.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(
      secondRow.getByRole("button", { name: "Remove device", exact: true }),
    ).toBeVisible();
    await assertAccessibleAndCapture(owner, "devices-remove-confirm");
    await secondRow.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(secondRow).toBeVisible();
    await expect(secondRow.getByRole("button", { name: "Remove device", exact: true })).toHaveCount(
      0,
    );

    await secondRow.getByRole("button", { name: "Remove", exact: true }).click();
    await secondRow.getByRole("button", { name: "Remove device", exact: true }).click();
    await expect(secondRow).toHaveCount(0);
    await expect(owner).toHaveURL(`${instance.origin}/devices`);
    await expect(second.page).toHaveURL(`${instance.origin}/login`);
    await expect(
      second.page.getByText("This browser was removed from Pneumo.", { exact: true }),
    ).toBeVisible();
    expect(await storedSessionCount(second.page)).toBe(0);
    await assertAccessibleAndCapture(second.page, "devices-revoked-login");

    const ownerRow = deviceRow(owner, signedIn.deviceName);
    await ownerRow.getByRole("button", { name: "Remove", exact: true }).click();
    await ownerRow.getByRole("button", { name: "Remove device", exact: true }).click();
    await expect(owner).toHaveURL(`${instance.origin}/login`);
    await expect(owner.getByRole("heading", { name: "Sign in" })).toBeVisible();
    expect(await storedSessionCount(owner)).toBe(0);
    await assertAccessibleAndCapture(owner, "devices-self-removed-login");
  } finally {
    await second.context.close();
  }
});

test("pairing QR regenerates, restores focus, and closes when an Android device claims it", async ({
  instance,
  signedIn,
}) => {
  const page = signedIn.page;
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  const addPhone = page.getByRole("button", { name: "Add a phone", exact: true });

  await openPairing(page);
  const dialog = page.getByRole("dialog", { name: "Add a phone" });
  await expect(
    dialog.getByText("Open Pneumo on your phone and tap Scan", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole("timer")).toContainText(/^Code expires in \d+:\d{2}$/);
  const initialPairing = await decodePairingCanvas(page);
  expect(initialPairing.origin === instance.origin).toBe(true);
  expect(await pairingKeyMatchesStoredSession(page, initialPairing.mk)).toBe(true);
  expect(
    await page.evaluate(() => document.documentElement.outerHTML.includes("pneumo://pair?")),
  ).toBe(false);
  await assertAccessibleAndCapture(page, "devices-pairing", { keepFocus: true });

  const regeneratedResponse = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "POST" &&
      new URL(candidate.url()).pathname === "/api/pair" &&
      candidate.status() === 201,
  );
  await dialog.getByRole("button", { name: "New code", exact: true }).click();
  await regeneratedResponse;
  await expect(page.getByLabel("Pairing QR code", { exact: true })).toBeVisible();
  const regeneratedPairing = await decodePairingCanvas(page);
  expect(regeneratedPairing.code !== initialPairing.code).toBe(true);
  expect(regeneratedPairing.origin === instance.origin).toBe(true);
  expect(await pairingKeyMatchesStoredSession(page, regeneratedPairing.mk)).toBe(true);

  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(addPhone).toBeFocused();

  await openPairing(page);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(addPhone).toBeFocused();

  await openPairing(page);
  const claimPairing = await decodePairingCanvas(page);
  const phoneName = "Pocket phone";
  const claimResponse = await page.request.post(`${instance.origin}/api/pair/claim`, {
    data: {
      code: claimPairing.code,
      device: { name: phoneName, platform: "android" },
    },
  });
  expect(claimResponse.status()).toBe(201);
  const claim = ClaimPairResponse.parse(await claimResponse.json());
  expect(claim.device.name).toBe(phoneName);
  expect(claim.device.platform).toBe("android");

  await expect(dialog).not.toBeVisible();
  const phoneRow = deviceRow(page, phoneName);
  await expect(phoneRow).toBeVisible();
  await expect(phoneRow).toHaveClass(/(?:^|\s)highlighted(?:\s|$)/);
  await assertAccessibleAndCapture(page, "devices-paired");
});
