import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { ErrorBody } from "@pneumo/protocol";
import { HTTPException } from "hono/http-exception";
import { afterAll, beforeAll, expect, test } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { createApp, systemClock } from "./app.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./log.js";
import { MemoryStorage } from "./storage/memory.js";
import type { UploadMode } from "./storage/upload-mode.js";

let webDist: string;
const html = "<!doctype html><html><body>Pneumo fixture</body></html>";

beforeAll(async () => {
  webDist = await mkdtemp(join(tmpdir(), "pneumo-app-"));
  await mkdir(join(webDist, "assets"));
  await Promise.all([
    writeFile(join(webDist, "index.html"), html),
    writeFile(join(webDist, "assets/app-B8xGgkQ2.js"), "export const app = true;"),
    writeFile(join(webDist, "sw.js"), "self.addEventListener('fetch', () => {});"),
    writeFile(join(webDist, "manifest.webmanifest"), '{"name":"Pneumo"}'),
    writeFile(join(webDist, "manifest.json"), '{"name":"Pneumo"}'),
  ]);
});

afterAll(async () => {
  await rm(webDist, { recursive: true, force: true });
});

function fixture(
  overrides: NodeJS.ProcessEnv = {},
  bucketOrigin?: string,
  uploadMode: UploadMode = bucketOrigin ? "direct" : "proxy",
) {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const config = loadConfig({
    PUBLIC_URL: "https://pneumo.example",
    S3_ENDPOINT: "https://objects.example",
    S3_BUCKET: "test-bucket",
    S3_ACCESS_KEY_ID: "fake-access-key",
    S3_SECRET_ACCESS_KEY: "fake-secret-key",
    WEB_DIST_DIR: webDist,
    ...overrides,
  });
  const instanceState = { initialized: false };
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  const app = createApp({
    config,
    storage: new MemoryStorage(bucketOrigin ? { bucketOrigin } : {}),
    uploadMode,
    logger: createLogger("info", destination),
    clock: { now: () => (now += 5) },
    instanceState,
  });
  return { app, instanceState, lines };
}

test("the production clock returns Unix epoch milliseconds", () => {
  expect(Math.abs(systemClock.now() - Date.now())).toBeLessThan(2_000);
});

test("health reports package version and live injected initialization state", async () => {
  const { app, instanceState } = fixture();
  const response = await app.request("/api/health");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    ok: true,
    version: packageJson.version,
    initialized: false,
  });
  instanceState.initialized = true;
  expect(await (await app.request("/api/health")).json()).toEqual({
    ok: true,
    version: packageJson.version,
    initialized: true,
  });
});

test.each(["/", "/index.html", "/devices/deep/link", "/apiary"])(
  "serves the SPA with no-cache at %s",
  async (path) => {
    const { app } = fixture();
    const response = await app.request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(await response.text()).toBe(html);
  },
);

test.each(["/api", "/api/", "/api/missing", "/api/missing/deep"])(
  "returns a protocol JSON 404 rather than the SPA at %s",
  async (path) => {
    const { app } = fixture();
    const response = await app.request(path);
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(ErrorBody.parse(await response.json())).toEqual({
      error: { code: "not_found", message: "Not found." },
    });
  },
);

test("does not use SPA fallback for non-GET requests", async () => {
  const { app } = fixture();
  const response = await app.request("/devices", { method: "POST" });
  expect(response.status).toBe(404);
  expect(ErrorBody.parse(await response.json()).error.code).toBe("not_found");
});

test("serves hashed assets immutably, with HEAD support", async () => {
  const { app } = fixture();
  const response = await app.request("/assets/app-B8xGgkQ2.js");
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  expect(await response.text()).toBe("export const app = true;");
  const head = await app.request("/assets/app-B8xGgkQ2.js", { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(head.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  expect(await head.text()).toBe("");
});

test.each(["/sw.js", "/manifest.webmanifest", "/manifest.json"])(
  "never caches the update entrypoint %s immutably",
  async (path) => {
    const { app } = fixture();
    const response = await app.request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    await response.arrayBuffer();
  },
);

test("HTML carries exact CSP and security headers", async () => {
  const { app } = fixture({}, "https://test-bucket.objects.example");
  const response = await app.request("/setup");
  expect(response.headers.get("Content-Security-Policy")).toBe(
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self' wss://pneumo.example https://test-bucket.objects.example; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  expect(response.headers.get("Strict-Transport-Security")).toBe(
    "max-age=31536000; includeSubDomains",
  );
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(response.headers.get("Permissions-Policy")).toBe(
    "camera=(), microphone=(), geolocation=()",
  );
  expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
  await response.text();
});

test("HTTP omits HSTS and CSP omits the bucket when storage supplies no origin", async () => {
  const { app } = fixture({ PUBLIC_URL: "http://localhost:8080" });
  const response = await app.request("/");
  expect(response.headers.has("Strict-Transport-Security")).toBe(false);
  expect(response.headers.get("Content-Security-Policy")).toContain(
    "connect-src 'self' wss://localhost:8080;",
  );
  await response.text();
});

test.each(["auto", "direct", "proxy"])(
  "resolved proxy mode omits the bucket origin even when configured mode is %s",
  async (mode) => {
    const { app } = fixture({ UPLOAD_MODE: mode }, "https://test-bucket.objects.example", "proxy");
    const response = await app.request("/");
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "connect-src 'self' wss://pneumo.example;",
    );
    await response.text();
  },
);

test("JSON body limit accepts exactly 128 KiB and rejects the next byte", async () => {
  const { app } = fixture();
  app.post("/body", async (c) => c.json({ size: (await c.req.text()).length }));
  for (const withLength of [false, true]) {
    for (const size of [128 * 1024, 128 * 1024 + 1]) {
      const body = `"${"x".repeat(size - 2)}"`;
      const response = await app.request("/body", {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          ...(withLength ? { "Content-Length": String(size) } : {}),
        },
        body,
      });
      expect(response.status).toBe(size === 128 * 1024 ? 200 : 413);
      expect(await response.json()).toEqual(
        size === 128 * 1024
          ? { size }
          : { error: { code: "payload_too_large", message: "Request body is too large." } },
      );
    }
  }
});

test("raw file bodies are not subject to the JSON limit", async () => {
  const { app } = fixture();
  app.put("/binary", async (c) => c.json({ size: (await c.req.arrayBuffer()).byteLength }));
  const size = 128 * 1024 + 1;
  const response = await app.request("/binary", {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(size),
  });
  expect(await response.json()).toEqual({ size });
});

test("errors are protocol JSON without exception details or stacks", async () => {
  const { app, lines } = fixture();
  app.post("/failure", () => {
    throw new Error("private failure detail");
  });
  app.post("/denied", () => {
    throw new HTTPException(401, { message: "private auth detail" });
  });
  for (const [path, status, code] of [
    ["/failure", 500, "internal"],
    ["/denied", 401, "unauthorized"],
  ] as const) {
    const response = await app.request(path, { method: "POST" });
    expect(response.status).toBe(status);
    const body = ErrorBody.parse(await response.json());
    expect(body.error.code).toBe(code);
    expect(JSON.stringify(body).includes("private")).toBe(false);
    expect(JSON.stringify(body).includes("stack")).toBe(false);
  }
  expect(lines.join("").includes("private")).toBe(false);
  const completed = lines.map((line) => JSON.parse(line)).filter((row) => row.status);
  expect(completed.map((row) => row.status)).toEqual([500, 401]);
});

test("request logs use child ids and method/path/status/ms, never file query credentials", async () => {
  const { app, lines } = fixture();
  const responses = await Promise.all([
    app.request("/api/files?signature=fake-query-credential"),
    app.request("/api/files/id/content?token=fake-query-token", {
      method: "POST",
      headers: { Authorization: "Bearer fake-request-token", "Content-Type": "application/json" },
      body: JSON.stringify({ token: "fake-body-token", authKey: "fake-body-auth" }),
    }),
  ]);
  const logs = lines.map((line) => JSON.parse(line));
  expect(logs.map((row) => ({ method: row.method, path: row.path, status: row.status }))).toEqual([
    { method: "GET", path: "/api/files", status: 404 },
    { method: "POST", path: "/api/files/id/content", status: 404 },
  ]);
  for (const [index, response] of responses.entries()) {
    expect(logs[index].requestId).toBe(response.headers.get("X-Request-Id"));
    expect(logs[index].ms).toBeGreaterThanOrEqual(5);
  }
  expect(logs[0].requestId).not.toBe(logs[1].requestId);
  expect(lines.join("").includes("fake-")).toBe(false);
});
