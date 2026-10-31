import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import packageJson from "../package.json" with { type: "json" };

const serverDir = new URL("../", import.meta.url);
const execute = promisify(execFile);
let webDist: string;
const html = "<!doctype html><html><body>Built server fixture</body></html>";

beforeAll(async () => {
  webDist = await mkdtemp(join(tmpdir(), "pneumo-runtime-"));
  await writeFile(join(webDist, "index.html"), html);
  await execute("pnpm", ["run", "build"], { cwd: serverDir });
}, 30_000);

afterAll(async () => {
  await rm(webDist, { recursive: true, force: true });
});

function start(env: NodeJS.ProcessEnv = {}) {
  return spawn(process.execPath, ["dist/index.js"], {
    cwd: serverDir,
    env: {
      PATH: process.env.PATH,
      PORT: "0",
      PUBLIC_URL: "http://localhost",
      S3_ENDPOINT: "http://127.0.0.1:1",
      S3_BUCKET: "fake-bucket",
      S3_ACCESS_KEY_ID: "fake-runtime-access",
      S3_SECRET_ACCESS_KEY: "fake-runtime-secret",
      WEB_DIST_DIR: webDist,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function terminate(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

test("bundled entrypoint serves protocol health and SPA under plain Node, then exits on SIGTERM", async () => {
  const child = start();
  const exited = once(child, "exit");
  const listening = Promise.withResolvers<number>();
  let output = "";
  const onData = (chunk: Buffer) => {
    output += chunk.toString();
    for (const line of output.split("\n")) {
      if (!line) continue;
      try {
        const row = JSON.parse(line);
        if (row.msg === "Server listening") listening.resolve(row.port);
      } catch {
        // A stdout chunk can end partway through a JSON line.
      }
    }
  };
  child.stdout?.on("data", onData);
  // This is a failure deadline for a real child process, not a readiness sleep.
  const timeout = setTimeout(() => listening.reject(new Error("Server did not start")), 10_000);
  child.once("exit", () => listening.reject(new Error("Server exited before listening")));
  try {
    const port = await listening.promise;
    const health = await fetch(`http://localhost:${port}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      ok: true,
      version: packageJson.version,
      initialized: false,
    });
    const page = await fetch(`http://localhost:${port}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect(page.headers.get("Cache-Control")).toBe("no-cache");
    expect(await page.text()).toBe(html);
    child.kill("SIGTERM");
    const [code, signal] = await exited;
    expect(code).toBe(0);
    expect(signal).toBeNull();
  } finally {
    clearTimeout(timeout);
    await terminate(child);
  }
}, 15_000);

test("invalid boot config exits 1 and prints all variable names, never their values", async () => {
  const child = start({
    PUBLIC_URL: "private-invalid-origin",
    S3_BUCKET: "",
    S3_ENDPOINT: "private-invalid-endpoint",
    S3_ACCESS_KEY_ID: "",
    S3_SECRET_ACCESS_KEY: "",
    PORT: "private-invalid-port",
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  try {
    const [code, signal] = await once(child, "exit");
    expect(code).toBe(1);
    expect(signal).toBeNull();
    for (const name of [
      "PUBLIC_URL",
      "S3_BUCKET",
      "S3_ENDPOINT",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
      "PORT",
    ]) {
      expect(stderr.includes(name)).toBe(true);
    }
    expect(stderr.includes("private-")).toBe(false);
    expect(stderr.includes("fake-runtime-")).toBe(false);
  } finally {
    await terminate(child);
  }
});
