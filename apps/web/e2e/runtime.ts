import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { createInterface } from "node:readline";
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
const startupTimeoutMs = 30_000;

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
    LOG_LEVEL: "info",
    TRUST_PROXY: "false",
  };
}

function isListeningEvent(value: unknown): value is { msg: "Server listening"; port: number } {
  if (value === null || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return (
    event.msg === "Server listening" &&
    Number.isInteger(event.port) &&
    (event.port as number) > 0 &&
    (event.port as number) <= 65_535
  );
}

function waitForListeningPort(child: ChildProcess, deadline: number): Promise<number> {
  const stdout = child.stdout;
  if (!stdout) {
    return Promise.reject(new Error("The web runtime did not expose its startup output"));
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    stdout.resume();
    return Promise.reject(new Error("The web runtime exited before it started listening"));
  }

  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    stdout.resume();
    return Promise.reject(new Error("Timed out waiting for the web runtime to start listening"));
  }

  const pending = Promise.withResolvers<number>();
  const lines = createInterface({ input: stdout, crlfDelay: Infinity });
  let settled = false;

  const cleanup = (): void => {
    clearTimeout(timer);
    lines.off("line", onLine);
    lines.off("close", onOutputClose);
    child.off("error", onChildError);
    child.off("exit", onChildExit);
    stdout.off("error", onOutputError);
    lines.close();
    stdout.resume();
  };
  const finish = (error: Error | null, port?: number): void => {
    if (settled) return;
    settled = true;
    cleanup();
    if (error) pending.reject(error);
    else pending.resolve(port as number);
  };
  const onLine = (line: string): void => {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (isListeningEvent(event)) finish(null, event.port);
  };
  const onChildError = (): void => {
    finish(new Error("The web runtime failed to start before it started listening"));
  };
  const onChildExit = (): void => {
    finish(new Error("The web runtime exited before it started listening"));
  };
  const onOutputError = (): void => {
    finish(new Error("The web runtime startup output stream failed"));
  };
  const onOutputClose = (): void => {
    finish(new Error("The web runtime startup output ended before it started listening"));
  };
  const timer = setTimeout(() => {
    finish(new Error("Timed out waiting for the web runtime to start listening"));
  }, remaining);

  lines.on("line", onLine);
  lines.once("close", onOutputClose);
  child.once("error", onChildError);
  child.once("exit", onChildExit);
  stdout.once("error", onOutputError);
  return pending.promise;
}

function waitForHealth(child: ChildProcess, port: number, deadline: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.reject(new Error("The web runtime exited before its health check completed"));
  }

  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return Promise.reject(new Error("Timed out waiting for the web runtime health check"));
  }

  const pending = Promise.withResolvers<void>();
  const controller = new AbortController();
  let settled = false;

  const cleanup = (): void => {
    clearTimeout(timer);
    child.off("error", onChildError);
    child.off("exit", onChildExit);
  };
  const finish = (error?: Error): void => {
    if (settled) return;
    settled = true;
    cleanup();
    if (error) pending.reject(error);
    else pending.resolve();
  };
  const onChildError = (): void => {
    controller.abort();
    finish(new Error("The web runtime failed before its health check completed"));
  };
  const onChildExit = (): void => {
    controller.abort();
    finish(new Error("The web runtime exited before its health check completed"));
  };
  const timer = setTimeout(() => {
    controller.abort();
    finish(new Error("Timed out waiting for the web runtime health check"));
  }, remaining);

  child.once("error", onChildError);
  child.once("exit", onChildExit);

  void fetch(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal })
    .then(async (response) => {
      await response.body?.cancel().catch(() => undefined);
      if (response.ok) {
        finish();
      } else {
        finish(new Error("The web runtime health check failed"));
      }
    })
    .catch(() => {
      if (settled) return;
      finish(new Error("The web runtime health check failed"));
    });
  return pending.promise;
}

async function waitUntilReady(child: ChildProcess, deadline: number): Promise<number> {
  const port = await waitForListeningPort(child, deadline);
  await waitForHealth(child, port, deadline);
  return port;
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
  const deadline = Date.now() + startupTimeoutMs;
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: serverDirectory,
    env: serverEnvironment(prefix, options),
    stdio: ["ignore", "pipe", "ignore"],
  });
  try {
    const port = await waitUntilReady(child, deadline);
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
