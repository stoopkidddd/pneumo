import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";

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
