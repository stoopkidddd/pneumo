import { randomUUID } from "node:crypto";
import { type BrowserContext, test as base, expect, type Page } from "@playwright/test";
import { type RunningWebRuntime, SETUP_TOKEN, startWebRuntime } from "./runtime.js";

export const PASSPHRASE = "correct horse battery staple";

export interface SignedInBrowser {
  context: BrowserContext;
  page: Page;
  passphrase: string;
  deviceName: string;
}

type WebFixtures = {
  instance: RunningWebRuntime;
  signedIn: SignedInBrowser;
};

export async function completeSetup(
  page: Page,
  origin: string,
  options: { deviceName?: string; acknowledge?: boolean } = {},
): Promise<void> {
  const deviceName = options.deviceName ?? "Owner browser";
  await page.goto(`${origin}/setup#token=${encodeURIComponent(SETUP_TOKEN)}`);
  await page.getByLabel("Passphrase", { exact: true }).fill(PASSPHRASE);
  await page.getByLabel("Repeat passphrase", { exact: true }).fill(PASSPHRASE);
  await page.getByLabel("Device name", { exact: true }).fill(deviceName);
  await page.getByRole("button", { name: "Create instance" }).click();
  await expect(page.getByRole("heading", { name: "Keep your passphrase safe" })).toBeVisible();
  if (options.acknowledge !== false) {
    await page
      .getByRole("checkbox", {
        name: "I understand that my history cannot be recovered without my passphrase",
      })
      .check();
    await page.getByRole("button", { name: "Continue to Home" }).click();
    await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
  }
}

export async function login(
  page: Page,
  origin: string,
  options: { passphrase?: string; deviceName?: string } = {},
): Promise<void> {
  await page.goto(origin);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByLabel("Passphrase", { exact: true }).fill(options.passphrase ?? PASSPHRASE);
  await page
    .getByLabel("Device name", { exact: true })
    .fill(options.deviceName ?? "Second browser");
  await page.getByRole("button", { name: "Sign in" }).click();
}

export const test = base.extend<WebFixtures>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires destructured fixture dependencies.
  instance: async ({}, use) => {
    const runtime = await startWebRuntime(`eng252/web/test/${randomUUID()}/`);
    try {
      await use(runtime);
    } finally {
      await runtime.stop();
    }
  },
  signedIn: async ({ browser, instance }, use) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const deviceName = "Owner browser";
    try {
      await completeSetup(page, instance.origin, { deviceName });
      await use({ context, page, passphrase: PASSPHRASE, deviceName });
    } finally {
      await context.close();
    }
  },
});

export { expect };
