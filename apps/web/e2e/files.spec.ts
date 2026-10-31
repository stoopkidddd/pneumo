import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import type {
  Browser,
  BrowserContext,
  Download,
  Locator,
  Page,
  Request,
  Response,
  Route,
} from "@playwright/test";
import { test as base, expect } from "@playwright/test";
import { ciphertextSize } from "@pneumo/protocol";
import type { SignedInBrowser } from "./fixtures.js";
import { completeSetup, login, PASSPHRASE } from "./fixtures.js";
import type { RunningWebRuntime } from "./runtime.js";
import { startWebRuntime } from "./runtime.js";

const screenshotDirectory = fileURLToPath(new URL("../test-results/screens", import.meta.url));
const defaultMaxFileBytes = 524_288_000;

type UploadMode = "direct" | "proxy";
type FilePayload = Extract<Parameters<Locator["setInputFiles"]>[0], { buffer: Buffer }>;

type FileTestFixtures = {
  uploadMode: UploadMode;
  maxFileBytes: number;
  instance: RunningWebRuntime;
  signedIn: SignedInBrowser;
};

const test = base.extend<FileTestFixtures>({
  uploadMode: ["direct", { option: true }],
  maxFileBytes: [defaultMaxFileBytes, { option: true }],
  instance: async ({ uploadMode, maxFileBytes }, use) => {
    const instance = await startWebRuntime(`eng261/web/${uploadMode}/${randomUUID()}/`, {
      uploadMode,
      maxFileBytes,
    });
    try {
      await use(instance);
    } finally {
      await instance.stop();
    }
  },
  signedIn: async ({ browser, instance }, use) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await completeSetup(page, instance.origin, { deviceName: "File sender" });
      await waitForFileSender(page);
      await use({ context, page, passphrase: PASSPHRASE, deviceName: "File sender" });
    } finally {
      await context.close();
    }
  },
});

function filePayload(
  name: string,
  buffer: Buffer,
  mimeType = "application/octet-stream",
): FilePayload {
  return { name, buffer, mimeType };
}

function push(page: Page, id: string): Locator {
  return page.locator(`article[data-push-id="${id}"]`);
}

function fileRow(page: Page, name: string): Locator {
  return page.locator("article[data-push-id]").filter({ hasText: name });
}

function isCreatePush(response: Response): boolean {
  return (
    response.request().method() === "POST" &&
    new URL(response.url()).pathname === "/api/pushes" &&
    response.ok()
  );
}
async function waitForFileSender(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Attach", exact: true })).toBeEnabled();
  await expect(page.getByLabel("Attach files", { exact: true })).toBeEnabled();
}

async function attachFile(page: Page, file: FilePayload): Promise<string> {
  await waitForFileSender(page);
  const created = page.waitForResponse(isCreatePush);
  await page.getByLabel("Attach files", { exact: true }).setInputFiles(file);
  const body = (await (await created).json()) as { id?: unknown };
  if (typeof body.id !== "string") throw new Error("Create push response has no id");
  return body.id;
}

async function openReceiver(
  browser: Browser,
  origin: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await login(page, origin, { deviceName: "File receiver" });
    await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
    await expect(page.getByText("Live", { exact: true })).toBeVisible();
    return { context, page };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function downloadBytes(row: Locator): Promise<{ download: Download; bytes: Buffer }> {
  const page = row.page();
  const pending = page.waitForEvent("download");
  await row.getByRole("button", { name: "Download", exact: true }).click();
  const download = await pending;
  const stream = await download.createReadStream();
  if (!stream) throw new Error("Downloaded file has no readable stream");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return { download, bytes: Buffer.concat(chunks) };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isUploadRequest(route: Route, origin: string): boolean {
  const request = route.request();
  if (request.method() !== "PUT") return false;
  const url = new URL(request.url());
  return url.origin !== origin || /^\/api\/files\/[^/]+\/content$/u.test(url.pathname);
}

function isDownloadContent(route: Route, origin: string): boolean {
  const request = route.request();
  if (request.method() !== "GET") return false;
  const url = new URL(request.url());
  return url.origin !== origin || /^\/api\/files\/[^/]+\/content$/u.test(url.pathname);
}

async function dispatchDrop(target: Locator, file: FilePayload, type: "dragenter" | "drop") {
  await waitForFileSender(target.page());
  await target.evaluate(
    (element, payload) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([Uint8Array.from(payload.bytes)], payload.name, { type: payload.mimeType }),
      );
      element.dispatchEvent(
        new DragEvent(payload.type, {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        }),
      );
    },
    {
      type,
      name: file.name,
      mimeType: file.mimeType,
      bytes: Array.from(file.buffer),
    },
  );
}

async function dispatchPaste(target: Locator, file: FilePayload): Promise<void> {
  await waitForFileSender(target.page());
  await target.evaluate(
    (element, payload) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([Uint8Array.from(payload.bytes)], payload.name, { type: payload.mimeType }),
      );
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: transfer,
        }),
      );
    },
    {
      name: file.name,
      mimeType: file.mimeType,
      bytes: Array.from(file.buffer),
    },
  );
}

async function assertAccessibleAndCapture(
  page: Page,
  name: "file-uploading" | "file-item" | "file-tamper" | "file-unavailable",
): Promise<void> {
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

for (const uploadMode of ["direct", "proxy"] as const) {
  test.describe(`${uploadMode} encrypted file transfers`, () => {
    test.use({ uploadMode });

    test("file actions stay unavailable until instance limits load, then send normally", async ({
      browser,
      instance,
    }) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const release = Promise.withResolvers<void>();
      const requested = Promise.withResolvers<void>();
      let reservations = 0;
      page.on("request", (request) => {
        if (request.method() === "POST" && new URL(request.url()).pathname === "/api/files") {
          reservations += 1;
        }
      });
      await page.route("**/api/me", async (route) => {
        requested.resolve();
        await release.promise;
        await route.continue();
      });
      try {
        await completeSetup(page, instance.origin, { deviceName: "Waiting for file limits" });
        await requested.promise;
        await expect(page.getByRole("button", { name: "Attach", exact: true })).toBeDisabled();
        await expect(page.getByLabel("Attach files", { exact: true })).toBeDisabled();
        await page
          .getByLabel("Attach files", { exact: true })
          .setInputFiles(filePayload("not-ready.txt", Buffer.from("must not send"), "text/plain"));
        await page.evaluate(() => {
          const transfer = new DataTransfer();
          transfer.items.add(new File(["must not send"], "not-ready.txt", { type: "text/plain" }));
          window.dispatchEvent(
            new DragEvent("dragenter", { cancelable: true, dataTransfer: transfer }),
          );
          window.dispatchEvent(new DragEvent("drop", { cancelable: true, dataTransfer: transfer }));
          window.dispatchEvent(
            new ClipboardEvent("paste", { cancelable: true, clipboardData: transfer }),
          );
        });
        await expect(page.getByText("Drop files to send", { exact: true })).toHaveCount(0);
        await expect(page.getByRole("alert")).toHaveCount(0);
        expect(reservations).toBe(0);
        if (uploadMode === "direct") await assertAccessibleAndCapture(page, "file-unavailable");
        release.resolve();
        await waitForFileSender(page);
        const bytes = Buffer.from("send after limits load");
        const id = await attachFile(page, filePayload("ready.txt", bytes, "text/plain"));
        const received = await downloadBytes(push(page, id));
        expect(received.bytes.equals(bytes)).toBe(true);
      } finally {
        release.resolve();
        await context.close();
      }
    });

    test("round-trips random files through a second browser", async ({
      browser,
      instance,
      signedIn,
    }) => {
      test.setTimeout(120_000);
      const owner = signedIn.page;
      const receiver = await openReceiver(browser, instance.origin);
      try {
        await expect(owner.getByRole("button", { name: "Attach", exact: true })).toBeVisible();
        await expect(owner.getByLabel("Attach files", { exact: true })).toHaveAttribute(
          "type",
          "file",
        );

        for (const size of [0, 1, 65_536, 5 * 1024 * 1024]) {
          const bytes = randomBytes(size);
          const name = `random-${size}.bin`;
          const id = await attachFile(owner, filePayload(name, bytes));
          await expect(push(owner, id)).toContainText(name);

          const received = push(receiver.page, id);
          await expect(received).toContainText(name, { timeout: 10_000 });
          const downloaded = await downloadBytes(received);
          expect(downloaded.download.suggestedFilename()).toBe(name);
          expect(downloaded.bytes).toHaveLength(bytes.length);
          expect(sha256(downloaded.bytes)).toBe(sha256(bytes));
        }
      } finally {
        await receiver.context.close();
      }
    });

    test("attaches multiple files immediately and applies the draft only to the first", async ({
      signedIn,
    }) => {
      const { page } = signedIn;
      await page.getByRole("button", { name: "Add a title" }).click();
      await page.getByLabel("Title", { exact: true }).fill("Files from the composer");
      await page.getByLabel("Message", { exact: true }).fill("Only the first file gets this note");

      let createPushes = 0;
      const countCreate = (request: Request) => {
        if (request.method() === "POST" && new URL(request.url()).pathname === "/api/pushes") {
          createPushes += 1;
        }
      };
      page.on("request", countCreate);
      try {
        await page
          .getByLabel("Attach files", { exact: true })
          .setInputFiles([
            filePayload("first.txt", Buffer.from("first"), "text/plain"),
            filePayload("second.txt", Buffer.from("second"), "text/plain"),
          ]);
        const first = fileRow(page, "first.txt");
        const second = fileRow(page, "second.txt");
        await expect(first).toHaveCount(1, { timeout: 10_000 });
        await expect(second).toHaveCount(1, { timeout: 10_000 });
        await expect(first).toContainText("Files from the composer");
        await expect(first).toContainText("Only the first file gets this note");
        await expect(second).not.toContainText("Files from the composer");
        await expect(second).not.toContainText("Only the first file gets this note");
        await expect.poll(() => createPushes).toBe(2);
      } finally {
        page.off("request", countCreate);
      }
    });

    test("accepts page and composer drops and an actual clipboard image", async ({ signedIn }) => {
      const { page } = signedIn;
      const main = page.locator("main");
      const message = page.getByLabel("Message", { exact: true });

      const pageDrop = filePayload("page-drop.txt", Buffer.from("page drop"), "text/plain");
      await dispatchDrop(main, pageDrop, "dragenter");
      await expect(page.getByText(/drop.*(?:send|upload)/i)).toBeVisible();
      const pageDropCreated = page.waitForResponse(isCreatePush);
      await dispatchDrop(main, pageDrop, "drop");
      await pageDropCreated;
      await expect(fileRow(page, pageDrop.name)).toHaveCount(1);

      const composerDrop = filePayload(
        "composer-drop.txt",
        Buffer.from("composer drop"),
        "text/plain",
      );
      const composerDropCreated = page.waitForResponse(isCreatePush);
      await dispatchDrop(message, composerDrop, "drop");
      await composerDropCreated;
      await expect(fileRow(page, composerDrop.name)).toHaveCount(1);

      const clipboardImage = filePayload(
        "clipboard-image.png",
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        "image/png",
      );
      const pasteCreated = page.waitForResponse(isCreatePush);
      await dispatchPaste(message, clipboardImage);
      await pasteCreated;
      await expect(fileRow(page, clipboardImage.name)).toHaveCount(1);
    });

    test("cancels a genuine in-flight upload without creating a push", async ({ signedIn }) => {
      const { context, page } = signedIn;
      const network = await context.newCDPSession(page);
      await network.send("Network.enable");
      await network.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: 128 * 1024,
      });
      const filename = "cancel-in-flight.bin";
      let createPushes = 0;
      const countCreate = (request: Request) => {
        if (request.method() === "POST" && new URL(request.url()).pathname === "/api/pushes") {
          createPushes += 1;
        }
      };
      page.on("request", countCreate);
      try {
        const uploading = page.locator("article[data-upload-id]").filter({ hasText: filename });
        await page
          .getByLabel("Attach files", { exact: true })
          .setInputFiles(filePayload(filename, randomBytes(2 * 1024 * 1024)));
        await expect(uploading.getByText(/Uploading/)).toBeVisible();
        const progress = uploading.getByRole("progressbar");
        await expect
          .poll(async () => Number(await progress.getAttribute("value")))
          .toBeGreaterThan(0);
        const loaded = Number(await progress.getAttribute("value"));
        expect(loaded).toBeLessThan(Number(await progress.getAttribute("max")));
        const aborted = page.waitForEvent("requestfailed", {
          predicate: (request) => request.method() === "PUT",
        });
        await uploading.getByRole("button", { name: "Cancel", exact: true }).click();
        await aborted;
        await expect(uploading.getByText("Upload cancelled. No push was sent.")).toBeVisible();
        expect(createPushes).toBe(0);

        await network.send("Network.emulateNetworkConditions", {
          offline: false,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
        });
        await page.reload();
        await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
        await expect(page.locator("article").filter({ hasText: filename })).toHaveCount(0);
        expect(createPushes).toBe(0);
      } finally {
        page.off("request", countCreate);
        await network.detach();
      }
    });

    test.describe("with an exact encrypted byte limit", () => {
      test.use({ maxFileBytes: ciphertextSize(1) });

      test("accepts the boundary and rejects larger plaintext before reserving a file", async ({
        signedIn,
      }) => {
        const { page } = signedIn;
        const boundaryId = await attachFile(page, filePayload("one-byte.bin", Buffer.from([0x7f])));
        await expect(push(page, boundaryId)).toContainText("one-byte.bin");

        let fileReservations = 0;
        const countReservations = (request: Request) => {
          if (request.method() === "POST" && new URL(request.url()).pathname === "/api/files") {
            fileReservations += 1;
          }
        };
        page.on("request", countReservations);
        try {
          await page
            .getByLabel("Attach files", { exact: true })
            .setInputFiles(filePayload("two-bytes.bin", Buffer.from([0x01, 0x02])));
          await expect(page.getByRole("alert")).toContainText(/too large|limit|maximum/i);
          await expect(page.locator("article").filter({ hasText: "two-bytes.bin" })).toHaveCount(0);
          expect(fileReservations).toBe(0);
        } finally {
          page.off("request", countReservations);
        }
      });
    });

    test("rejects tampered authenticated bytes without saving a file", async ({
      instance,
      signedIn,
    }) => {
      const { page } = signedIn;
      const filename = "tamper-check.bin";
      const id = await attachFile(page, filePayload(filename, randomBytes(4_096)));
      const row = push(page, id);
      await expect(row).toContainText(filename);

      let downloadEvents = 0;
      page.on("download", () => {
        downloadEvents += 1;
      });
      const tamperDownload = async (route: Route) => {
        if (!isDownloadContent(route, instance.origin)) {
          await route.fallback();
          return;
        }
        const response = await route.fetch();
        const body = await response.body();
        if (body.length === 0) throw new Error("Encrypted download was unexpectedly empty");
        body[body.length - 1] = (body[body.length - 1] ?? 0) ^ 1;
        await route.fulfill({ response, body });
      };
      await page.route("**/*", tamperDownload);
      try {
        await row.getByRole("button", { name: "Download", exact: true }).click();
        await expect(
          page.getByText("This file was corrupted or tampered with", { exact: true }),
        ).toBeVisible();
        expect(downloadEvents).toBe(0);
      } finally {
        await page.unroute("**/*", tamperDownload);
      }
    });
  });
}

test.describe("file transfer visual states", () => {
  test.use({ uploadMode: "direct" });

  test("captures uploading, completed, and tampered file surfaces", async ({
    instance,
    signedIn,
  }) => {
    test.setTimeout(90_000);
    const { page } = signedIn;
    const filename = "quarterly-report.pdf";
    const transferred = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holdUpload = async (route: Route) => {
      if (!isUploadRequest(route, instance.origin)) {
        await route.fallback();
        return;
      }
      const response = await route.fetch();
      transferred.resolve();
      await release.promise;
      await route.fulfill({ response });
    };
    await page.route("**/*", holdUpload);
    try {
      await page
        .getByLabel("Attach files", { exact: true })
        .setInputFiles(filePayload(filename, randomBytes(128 * 1024), "application/pdf"));
      await transferred.promise;
      const uploading = page.locator("article[data-upload-id]").filter({ hasText: filename });
      await expect(uploading).toHaveCount(1);
      await expect(uploading.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
      await assertAccessibleAndCapture(page, "file-uploading");

      const created = page.waitForResponse(isCreatePush);
      release.resolve();
      const result = (await (await created).json()) as { id?: unknown };
      if (typeof result.id !== "string") throw new Error("Create push response has no id");
      await page.unroute("**/*", holdUpload);
      const row = push(page, result.id);
      await expect(row).toContainText(filename);
      await expect(row.getByRole("button", { name: "Download", exact: true })).toBeVisible();
      await assertAccessibleAndCapture(page, "file-item");

      const tamperDownload = async (route: Route) => {
        if (!isDownloadContent(route, instance.origin)) {
          await route.fallback();
          return;
        }
        const response = await route.fetch();
        const body = await response.body();
        if (body.length === 0) throw new Error("Encrypted download was unexpectedly empty");
        body[body.length - 1] = (body[body.length - 1] ?? 0) ^ 1;
        await route.fulfill({ response, body });
      };
      await page.route("**/*", tamperDownload);
      try {
        await row.getByRole("button", { name: "Download", exact: true }).click();
        await expect(
          page.getByText("This file was corrupted or tampered with", { exact: true }),
        ).toBeVisible();
        await assertAccessibleAndCapture(page, "file-tamper");
      } finally {
        await page.unroute("**/*", tamperDownload);
      }
    } finally {
      release.resolve();
      await page.unroute("**/*", holdUpload);
    }
  });
});
