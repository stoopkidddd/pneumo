import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import type { Browser, BrowserContext, Page, Route, WebSocketRoute } from "@playwright/test";
import { b64uEncode, deriveKeys, deriveMasterKey, encryptPush } from "@pneumo/crypto";
import { AuthParamsResponse, ClientFrame, ServerFrame, uuidv7 } from "@pneumo/protocol";
import { expect, login, PASSPHRASE, test } from "./fixtures.js";

const screenshotDirectory = fileURLToPath(new URL("../test-results/screens", import.meta.url));
const secondDeviceName = "Second browser";

type SeedPayload =
  | { type: "note"; title?: string; body: string }
  | { type: "link"; title?: string; body?: string; url: string };

async function openSecondBrowser(
  browser: Browser,
  origin: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, origin, { deviceName: secondDeviceName });
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
  return { context, page };
}

async function waitForLive(page: Page): Promise<void> {
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
}

async function targetDevice(page: Page, deviceName: string): Promise<void> {
  const select = page.getByLabel("Send to", { exact: true });
  const option = select.locator("option").filter({ hasText: deviceName });
  await expect(option).toHaveCount(1);
  const value = await option.getAttribute("value");
  if (!value) throw new Error(`Target option for ${deviceName} has no value`);
  await select.selectOption(value);
}

async function sendWithButton(page: Page, message: string): Promise<string> {
  await page.getByLabel("Message", { exact: true }).fill(message);
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/pushes" &&
      response.ok(),
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const response = await responsePromise;
  const body = (await response.json()) as { id?: unknown };
  if (typeof body.id !== "string") throw new Error("Create push response has no id");
  return body.id;
}

async function sendWithEnter(page: Page): Promise<string> {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/pushes" &&
      response.ok(),
  );
  await page.getByLabel("Message", { exact: true }).press("Enter");
  const response = await responsePromise;
  const body = (await response.json()) as { id?: unknown };
  if (typeof body.id !== "string") throw new Error("Create push response has no id");
  return body.id;
}

function push(page: Page, id: string) {
  return page.locator(`article[data-push-id="${id}"]`);
}

async function seedPushes(
  page: Page,
  payloads: SeedPayload[],
  options: { corrupt?: boolean } = {},
): Promise<string[]> {
  const params = AuthParamsResponse.parse(
    await (await page.request.get(new URL("/api/auth/params", page.url()).href)).json(),
  );
  const mk = await deriveMasterKey(PASSPHRASE, params.kdf);
  const { contentKey } = await deriveKeys(mk);
  mk.fill(0);
  const records = await Promise.all(
    payloads.map(async (payload) => {
      const id = uuidv7();
      const envelope = await encryptPush(contentKey, id, payload);
      if (options.corrupt) envelope.c = b64uEncode(new Uint8Array(16));
      return { id, targetDeviceId: null, envelope, file: null };
    }),
  );
  return page.evaluate(async (records) => {
    type StoredSession = { token?: unknown };
    const opened = Promise.withResolvers<IDBDatabase>();
    const request = indexedDB.open("pneumo");
    request.onerror = () => opened.reject(request.error);
    request.onsuccess = () => opened.resolve(request.result);
    const database = await opened.promise;
    let session: StoredSession | undefined;
    try {
      const loaded = Promise.withResolvers<StoredSession | undefined>();
      const transaction = database.transaction("session", "readonly");
      const load = transaction.objectStore("session").get("current");
      load.onerror = () => loaded.reject(load.error);
      load.onsuccess = () => loaded.resolve(load.result as StoredSession | undefined);
      session = await loaded.promise;
    } finally {
      database.close();
    }
    if (typeof session?.token !== "string") {
      throw new Error("A signed-in browser session is required to seed pushes");
    }
    const token = session.token;
    const ids: string[] = [];
    for (const record of records) {
      const { id } = record;
      const response = await fetch("/api/pushes", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(record),
      });
      if (!response.ok) throw new Error(`Unable to seed push: HTTP ${response.status}`);
      const created = (await response.json()) as { id?: unknown };
      if (created.id !== id) throw new Error("Seeded push response id did not match its request");
      ids.push(id);
    }
    return ids;
  }, records);
}

async function assertAccessibleAndCapture(
  page: Page,
  name:
    | "home-empty"
    | "home-items"
    | "home-offline"
    | "home-error"
    | "home-send-success-focus"
    | "home-send-error-focus",
  { keepFocus = false }: { keepFocus?: boolean } = {},
): Promise<void> {
  await mkdir(screenshotDirectory, { recursive: true });
  await page.evaluate(async (keepFocus) => {
    await document.fonts.ready;
    if (!keepFocus) document.getElementById("main")?.focus({ preventScroll: true });
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
  await page.screenshot({
    path: join(screenshotDirectory, `${name}-mobile.png`),
    fullPage: true,
    animations: "disabled",
  });
  if (desktopViewport) await page.setViewportSize(desktopViewport);
  await page.emulateMedia({ colorScheme: null });
}

test("two browsers receive, target, copy, open, and delete pushes", async ({
  browser,
  instance,
  signedIn,
}) => {
  const owner = signedIn.page;
  const second = await openSecondBrowser(browser, instance.origin);
  try {
    await Promise.all([waitForLive(owner), waitForLive(second.page)]);
    await second.context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: instance.origin,
    });

    await owner.getByRole("button", { name: "Add a title" }).click();
    await owner.getByLabel("Title", { exact: true }).fill("A shared note");
    const message = owner.getByLabel("Message", { exact: true });
    await message.fill("First line");
    await message.press("Shift+Enter");
    await message.type("Second line");
    await expect(message).toHaveValue("First line\nSecond line");
    const noteId = await sendWithEnter(owner);

    const ownerNote = push(owner, noteId);
    const secondNote = push(second.page, noteId);
    await expect(secondNote).toBeVisible({ timeout: 2_000 });
    await expect(ownerNote).toBeVisible();
    await expect(secondNote).toContainText("A shared note");
    await expect(secondNote).toContainText("First line");
    await expect(ownerNote).toContainText("Owner browser");
    await expect(secondNote).toContainText("Owner browser");
    await expect(message).toBeFocused();
    await assertAccessibleAndCapture(owner, "home-send-success-focus", { keepFocus: true });
    await expect(message).toBeFocused();
    await owner.keyboard.type("Ready for the next push");
    await expect(message).toHaveValue("Ready for the next push");
    await message.clear();
    await secondNote.getByRole("button", { name: "Copy", exact: true }).click();
    await expect
      .poll(() => second.page.evaluate(() => navigator.clipboard.readText()))
      .toBe("First line\nSecond line");

    await targetDevice(owner, secondDeviceName);
    const linkUrl = "https://example.com/eng-257";
    const linkId = await sendWithButton(owner, linkUrl);
    const secondLink = push(second.page, linkId);
    await expect(secondLink).toBeVisible({ timeout: 2_000 });
    await expect(push(owner, linkId)).toBeVisible();
    await expect(push(owner, linkId)).toContainText(linkUrl);
    const open = secondLink.getByRole("link", { name: "Open", exact: true });
    await expect(open).toHaveAttribute("href", linkUrl);
    await expect(open).toHaveAttribute("target", "_blank");
    await expect(open).toHaveAttribute("rel", /\bnoopener\b/);
    await expect(open).toHaveAttribute("rel", /\bnoreferrer\b/);
    await secondLink.getByRole("button", { name: "Copy", exact: true }).click();
    await expect
      .poll(() => second.page.evaluate(() => navigator.clipboard.readText()))
      .toBe(linkUrl);

    await secondNote.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(secondNote.getByRole("button", { name: "Confirm delete" })).toBeVisible();
    await expect(secondNote.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
    await secondNote.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(secondNote).toBeVisible();
    await secondNote.getByRole("button", { name: "Delete", exact: true }).click();
    await secondNote.getByRole("button", { name: "Confirm delete" }).click();
    await expect(secondNote).toHaveCount(0);
    await expect(ownerNote).toHaveCount(0, { timeout: 2_000 });
  } finally {
    await second.context.close();
  }
});

test("composer retains failed drafts, retries, and enforces the encrypted limit", async ({
  signedIn,
}) => {
  const { page } = signedIn;
  await waitForLive(page);
  const draft = "Keep this draft after a temporary failure";
  let failedOnce = false;
  const failFirstCreate = async (route: Route) => {
    if (route.request().method() === "POST" && !failedOnce) {
      failedOnce = true;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "internal", message: "Temporary failure" } }),
      });
      return;
    }
    await route.fallback();
  };
  await page.route("**/api/pushes", failFirstCreate);
  await page.getByLabel("Message", { exact: true }).fill(draft);
  await page.getByLabel("Message", { exact: true }).press("Enter");
  await expect(page.getByRole("alert")).toContainText(/temporary|try again|could not send|failed/i);
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue(draft);
  await expect(page.getByLabel("Message", { exact: true })).toBeFocused();
  await assertAccessibleAndCapture(page, "home-send-error-focus", { keepFocus: true });
  await expect(page.locator("article").filter({ hasText: draft })).toHaveCount(0);
  await page.unroute("**/api/pushes", failFirstCreate);
  const id = await sendWithButton(page, draft);
  await expect(push(page, id)).toContainText(draft);
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue("");

  let createRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/pushes") {
      createRequests += 1;
    }
  });
  await page.getByLabel("Message", { exact: true }).fill("x".repeat(70_000));
  const send = page.getByRole("button", { name: "Send", exact: true });
  if (await send.isDisabled()) {
    await expect(page.getByText(/too (?:large|long)|limit|maximum|shorten/i)).toBeVisible();
  } else {
    await send.click();
    await expect(page.getByRole("alert")).toContainText(
      /too (?:large|long)|limit|maximum|shorten/i,
    );
  }
  expect(createRequests).toBe(0);
});

test("history decrypt fallback, pagination, and an old deep link remain usable", async ({
  instance,
  signedIn,
}) => {
  const { page } = signedIn;
  await waitForLive(page);
  const oldBody = "Oldest item outside the first page";
  const [oldId] = await seedPushes(page, [{ type: "note", body: oldBody }]);
  if (!oldId) throw new Error("Old push was not created");
  await seedPushes(
    page,
    Array.from({ length: 55 }, (_, index) => ({
      type: "note" as const,
      body: `Pagination item ${String(index + 1).padStart(2, "0")}`,
    })),
  );

  await page.reload();
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
  await expect(page.locator("article[data-push-id]")).toHaveCount(50);
  await expect(push(page, oldId)).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(push(page, oldId)).toContainText(oldBody);
  expect(await page.locator("article[data-push-id]").count()).toBeGreaterThan(50);

  const [corruptId] = await seedPushes(
    page,
    [{ type: "note", body: "This plaintext must never render" }],
    { corrupt: true },
  );
  if (!corruptId) throw new Error("Corrupt push was not created");
  await expect(push(page, corruptId)).toContainText("Can't decrypt this push");
  await expect(push(page, corruptId)).not.toContainText("This plaintext must never render");
  const [longId] = await seedPushes(page, [
    {
      type: "link",
      url: "https://example.com/long-body",
      body: "A line of linked context.\n".repeat(16),
    },
  ]);
  if (!longId) throw new Error("Long push was not created");
  const longPush = push(page, longId);
  const expand = longPush.getByRole("button", { name: "Show more" });
  await expect(expand).toBeVisible();
  const collapsed = await longPush.locator(".push-body").last().boundingBox();
  await expand.click();
  await expect(longPush.getByRole("button", { name: "Show less" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  const expanded = await longPush.locator(".push-body").last().boundingBox();
  expect(expanded?.height ?? 0).toBeGreaterThan(collapsed?.height ?? 0);

  await page.goto(`${instance.origin}/?push=${encodeURIComponent(oldId)}`);
  const highlighted = push(page, oldId);
  await expect(highlighted).toBeVisible();
  await expect(highlighted).toHaveClass(/\bhighlighted\b/);
  await expect(highlighted.getByRole("button", { name: "Copy", exact: true })).toBeFocused();
});

test("Home states are accessible in both themes and have desktop and mobile captures", async ({
  signedIn,
}) => {
  const { context, page } = signedIn;
  await waitForLive(page);
  await expect(page.locator("article[data-push-id]")).toHaveCount(0);
  await assertAccessibleAndCapture(page, "home-empty");

  await page.getByRole("button", { name: "Add a title" }).click();
  await page.getByLabel("Title", { exact: true }).fill("Screenshot note");
  const noteId = await sendWithButton(page, "A note in the real Home history.");
  await expect(push(page, noteId)).toBeVisible();
  const linkId = await sendWithButton(page, "https://example.com/screenshot");
  await expect(push(page, linkId).getByRole("link", { name: "Open", exact: true })).toBeVisible();
  await assertAccessibleAndCapture(page, "home-items");

  try {
    await context.setOffline(true);
    await expect(page.locator(".offline-banner")).toBeVisible();
    await assertAccessibleAndCapture(page, "home-offline");
  } finally {
    await context.setOffline(false);
  }
});

test("history fetch errors offer an in-place retry without losing the composer", async ({
  signedIn,
}) => {
  const { page } = signedIn;
  await page.route("**/api/pushes?*", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "internal", message: "Temporary failure" } }),
      });
    } else await route.fallback();
  });
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("Could not load your history");
  await assertAccessibleAndCapture(page, "home-error");
  await page.unroute("**/api/pushes?*");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("Nothing here yet.", { exact: true })).toBeVisible();
  const message = page.getByLabel("Message", { exact: true });
  const initial = await message.boundingBox();
  await message.fill("Line\n".repeat(12));
  const grown = await message.boundingBox();
  expect(grown?.height ?? 0).toBeGreaterThan(initial?.height ?? 0);
});

test("a pending send is visible immediately and reconciles to one confirmed row", async ({
  signedIn,
}) => {
  const { page } = signedIn;
  await waitForLive(page);
  const held = Promise.withResolvers<void>();
  await page.route("**/api/pushes", async (route) => {
    if (route.request().method() === "POST") await held.promise;
    await route.continue();
  });
  try {
    await page.getByLabel("Message", { exact: true }).fill("Optimistic dispatch");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const row = page.locator("article").filter({ hasText: "Optimistic dispatch" });
    await expect(row).toHaveCount(1);
    await expect(row.getByText("Sending…", { exact: true })).toBeVisible();
    const response = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/pushes" &&
        response.ok(),
    );
    held.resolve();
    const confirmed = (await (await response).json()) as { id: string };
    await expect(row).toHaveAttribute("data-push-id", confirmed.id);
    await expect(row.getByText("Sending…", { exact: true })).toHaveCount(0);
    await expect(row).toHaveCount(1);
  } finally {
    held.resolve();
    await page.unroute("**/api/pushes");
  }
});

test("a disconnected browser receives missed pushes through WebSocket replay", async ({
  browser,
  instance,
  signedIn,
}) => {
  const context = await browser.newContext();
  const connections: {
    client: WebSocketRoute;
    server: WebSocketRoute;
    since: string | null | undefined;
    frames: { type: string; id: string | null }[];
  }[] = [];
  let offline = false;
  let offlineConnectionAttempts = 0;
  await context.routeWebSocket("**/api/ws", async (client) => {
    if (offline) {
      offlineConnectionAttempts += 1;
      await client.close({ code: 1012, reason: "Offline test connection" });
      return;
    }
    const server = client.connectToServer();
    const connection = {
      client,
      server,
      since: undefined as string | null | undefined,
      frames: [] as { type: string; id: string | null }[],
    };
    connections.push(connection);
    client.onMessage((message) => {
      const frame = ClientFrame.parse(JSON.parse(message.toString()));
      if (frame.type === "hello") connection.since = frame.since;
      server.send(message);
    });
    server.onMessage((message) => {
      const frame = ServerFrame.parse(JSON.parse(message.toString()));
      connection.frames.push({
        type: frame.type,
        id: frame.type === "push" ? frame.push.id : null,
      });
      client.send(message);
    });
  });
  const page = await context.newPage();
  try {
    await login(page, instance.origin, { deviceName: secondDeviceName });
    await Promise.all([waitForLive(signedIn.page), waitForLive(page)]);
    const cursorId = await sendWithButton(signedIn.page, "Known before disconnect");
    await expect(push(page, cursorId)).toBeVisible({ timeout: 2_000 });
    const original = connections.at(-1);
    if (!original) throw new Error("Second browser has no proxied connection");

    offline = true;
    await context.setOffline(true);
    await Promise.all([
      original.client.close({ code: 1001, reason: "Network disconnected" }),
      original.server.close({ code: 1001, reason: "Network disconnected" }),
    ]);
    await expect.poll(() => offlineConnectionAttempts).toBeGreaterThan(0);
    await expect(page.locator(".offline-banner")).toBeVisible();
    const replayBody = "Delivered through replay after reconnect";
    const replayId = await sendWithButton(signedIn.page, replayBody);
    await expect(push(page, replayId)).toHaveCount(0);

    const connectionCount = connections.length;
    offline = false;
    await context.setOffline(false);
    await expect.poll(() => connections.length).toBeGreaterThan(connectionCount);
    const reconnected = connections.at(-1);
    if (!reconnected) throw new Error("Second browser did not reconnect");
    expect(reconnected).not.toBe(original);
    await expect.poll(() => reconnected.since).toBe(cursorId);
    await expect
      .poll(() =>
        reconnected.frames.filter(
          (frame) =>
            frame.type === "ready" || frame.type === "push" || frame.type === "replay_done",
        ),
      )
      .toEqual([
        { type: "ready", id: null },
        { type: "push", id: replayId },
        { type: "replay_done", id: null },
      ]);
    await expect(push(page, replayId)).toContainText(replayBody);
  } finally {
    await context.close();
  }
});
