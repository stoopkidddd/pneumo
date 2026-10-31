import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  type MinioInstance,
  startMinio as provisionMinio,
  stopMinio,
} from "../../../scripts/e2e/minio.js";
import { S3Storage } from "../../server/src/storage/s3.js";

const execute = promisify(execFile);
const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
const serverDirectory = join(workspaceRoot, "apps/server");
const webDistDirectory = join(workspaceRoot, "apps/web/dist");

export const SETUP_TOKEN = "fixed-e2e-setup-token";

export interface RunningWebRuntime {
  child: ChildProcess;
  origin: string;
  readDeviceHasWebPush(deviceId: string): Promise<boolean>;
  stop(): Promise<void>;
}

export interface WebRuntimeOptions {
  uploadMode?: "direct" | "proxy";
  maxFileBytes?: number;
}

export async function startMinio(options: { envOut?: string } = {}): Promise<MinioInstance> {
  const instance = await provisionMinio(options);
  for (const [name, value] of Object.entries(instance.env)) {
    process.env[`PNEUMO_E2E_${name}`] = value;
  }
  return instance;
}

export type { MinioInstance };
export { stopMinio };

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing Playwright harness variable: ${name}`);
  return value;
}

function serverEnvironment(prefix: string, options: WebRuntimeOptions = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    PORT: "0",
    PUBLIC_URL: "http://127.0.0.1",
    S3_ENDPOINT: required("PNEUMO_E2E_S3_ENDPOINT"),
    S3_REGION: required("PNEUMO_E2E_S3_REGION"),
    S3_BUCKET: required("PNEUMO_E2E_S3_BUCKET"),
    S3_ACCESS_KEY_ID: required("PNEUMO_E2E_S3_ACCESS_KEY_ID"),
    S3_SECRET_ACCESS_KEY: required("PNEUMO_E2E_S3_SECRET_ACCESS_KEY"),
    S3_FORCE_PATH_STYLE: required("PNEUMO_E2E_S3_FORCE_PATH_STYLE"),
    S3_PREFIX: prefix,
    PNEUMO_SETUP_TOKEN: SETUP_TOKEN,
    UPLOAD_MODE: options.uploadMode ?? "direct",
    ...(options.maxFileBytes === undefined ? {} : { MAX_FILE_BYTES: String(options.maxFileBytes) }),
    WEB_DIST_DIR: webDistDirectory,
    LOG_LEVEL: "silent",
    TRUST_PROXY: "false",
  };
}

async function darwinListeningPort(pid: number): Promise<number | null> {
  try {
    const { stdout } = await execute(
      "/usr/sbin/lsof",
      ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"],
      { timeout: 1_000 },
    );
    for (const line of stdout.split("\n")) {
      const match = /^n.*:(\d+)$/.exec(line);
      if (match?.[1]) return Number(match[1]);
    }
  } catch {
    // The process may not have opened its listener yet.
  }
  return null;
}

async function linuxSocketInodes(pid: number): Promise<Set<string>> {
  const inodes = new Set<string>();
  const directory = `/proc/${pid}/fd`;
  for (const descriptor of await readdir(directory)) {
    try {
      const target = await readlink(join(directory, descriptor));
      const match = /^socket:\[(\d+)\]$/.exec(target);
      if (match?.[1]) inodes.add(match[1]);
    } catch {
      // File descriptors can close while they are inspected.
    }
  }
  return inodes;
}

async function linuxListeningPort(pid: number): Promise<number | null> {
  try {
    const inodes = await linuxSocketInodes(pid);
    for (const table of ["tcp", "tcp6"]) {
      const rows = await readFile(`/proc/${pid}/net/${table}`, "utf8");
      for (const row of rows.trim().split("\n").slice(1)) {
        const columns = row.trim().split(/\s+/);
        if (columns[3] !== "0A" || !columns[9] || !inodes.has(columns[9])) continue;
        const port = Number.parseInt(columns[1]?.split(":")[1] ?? "", 16);
        if (Number.isInteger(port) && port > 0) return port;
      }
    }
  } catch {
    // The process or its proc entries may not exist yet.
  }
  return null;
}

async function processListeningPort(pid: number): Promise<number | null> {
  if (process.platform === "darwin") return darwinListeningPort(pid);
  if (process.platform === "linux") return linuxListeningPort(pid);
  throw new Error(`PORT=0 discovery is unsupported on ${process.platform}`);
}

async function waitUntilReady(child: ChildProcess): Promise<number> {
  if (!child.pid) throw new Error("The web runtime did not start");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("The web runtime exited before it became ready");
    }
    const port = await processListeningPort(child.pid);
    if (port !== null) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
          signal: AbortSignal.timeout(1_000),
        });
        await response.body?.cancel();
        if (response.ok) return port;
      } catch {
        // The listener can be visible before it accepts requests.
      }
    }
    await delay(100);
  }
  throw new Error("The web runtime did not become ready");
}

export async function stopWebRuntime(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

async function readDeviceHasWebPush(prefix: string, deviceId: string): Promise<boolean> {
  const storage = new S3Storage({
    S3_ENDPOINT: required("PNEUMO_E2E_S3_ENDPOINT"),
    S3_REGION: required("PNEUMO_E2E_S3_REGION"),
    S3_BUCKET: required("PNEUMO_E2E_S3_BUCKET"),
    S3_ACCESS_KEY_ID: required("PNEUMO_E2E_S3_ACCESS_KEY_ID"),
    S3_SECRET_ACCESS_KEY: required("PNEUMO_E2E_S3_SECRET_ACCESS_KEY"),
    S3_FORCE_PATH_STYLE: required("PNEUMO_E2E_S3_FORCE_PATH_STYLE") === "true",
    S3_PREFIX: prefix,
  });
  try {
    const record = await storage.getJson<{ webPush: unknown }>(`devices/${deviceId}.json`);
    return record.webPush !== null;
  } finally {
    storage.destroy();
  }
}

export async function startWebRuntime(
  prefix: string,
  options: WebRuntimeOptions = {},
): Promise<RunningWebRuntime> {
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: serverDirectory,
    env: serverEnvironment(prefix, options),
    stdio: "ignore",
  });
  try {
    await once(child, "spawn");
    const port = await waitUntilReady(child);
    return {
      child,
      origin: `http://127.0.0.1:${port}`,
      readDeviceHasWebPush: (deviceId) => readDeviceHasWebPush(prefix, deviceId),
      stop: () => stopWebRuntime(child),
    };
  } catch (error) {
    await stopWebRuntime(child);
    throw error;
  }
}

export async function buildWebRuntime(): Promise<void> {
  await execute("pnpm", ["--filter", "@pneumo/server", "--filter", "@pneumo/web", "run", "build"], {
    cwd: workspaceRoot,
    timeout: 180_000,
  });
}
