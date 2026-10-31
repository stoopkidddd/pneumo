import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { completeSetup, expect, test } from "./fixtures.js";

const screenshotDirectory = fileURLToPath(new URL("../test-results/screens", import.meta.url));

test("a waiting worker offers Reload to update and activates only after confirmation", async ({
  browser,
  instance,
}) => {
  let version = 1;
  // Give this test a private origin and worker response; never mutate shared build output.
  const proxy = createServer((incoming, outgoing) => {
    if (incoming.url === "/sw.js") {
      void (async () => {
        const response = await fetch(`${instance.origin}/sw.js`);
        const script = await response.text();
        outgoing.writeHead(response.status, {
          "Content-Type": "text/javascript",
          "Cache-Control": "no-cache",
        });
        outgoing.end(`${script}\n// update smoke ${version}\n`);
      })().catch(() => {
        outgoing.writeHead(502);
        outgoing.end();
      });
      return;
    }
    const forwarded = request(
      new URL(incoming.url ?? "/", instance.origin),
      {
        method: incoming.method,
        headers: incoming.headers,
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    forwarded.on("error", () => {
      outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(forwarded);
  });
  proxy.on("upgrade", (_request, socket) => socket.destroy());
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const address = proxy.address();
  if (!address || typeof address === "string")
    throw new Error("The private update proxy did not listen");
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await completeSetup(page, `http://127.0.0.1:${address.port}`);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
    version = 2;
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      await registration.update();
    });
    const update = page.getByRole("button", { name: "Reload to update", exact: true });
    await expect(update).toBeVisible();
    expect(
      await page.evaluate(async () => Boolean((await navigator.serviceWorker.ready).waiting)),
    ).toBe(true);
    await mkdir(screenshotDirectory, { recursive: true });
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.screenshot({
        path: join(screenshotDirectory, `pwa-update-${colorScheme}.png`),
        fullPage: true,
        animations: "disabled",
      });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "light" });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({
      path: join(screenshotDirectory, "pwa-update-mobile.png"),
      fullPage: true,
    });
    const reloaded = page.waitForEvent("load");
    await update.click();
    await reloaded;
    await expect(update).not.toBeVisible();
    await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
    expect(
      await page.evaluate(async () => (await navigator.serviceWorker.ready).waiting === null),
    ).toBe(true);
  } finally {
    await context.close();
    proxy.closeAllConnections();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    proxy.close((error) => (error ? reject(error) : resolve()));
    await promise;
  }
});
