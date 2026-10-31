import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, inject, test } from "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    minio: Record<string, string>;
  }
}

const minio = inject("minio");
const repositoryDir = new URL("../../", import.meta.url);
const serverDir = new URL("../../apps/server/", import.meta.url);
const SETUP_TOKEN = "fixed-e2e-setup-token";
const PASSPHRASE = "pneumo smoke test passphrase";
const STEPS = [
  "authentication",
  "pair and claim",
  "note over WebSocket",
  "link over WebSocket",
  "2 MB file round trip",
  "push_deleted",
  "revoke closes 4401",
] as const;

function required(name: string): string {
  const value = minio[name];
  if (!value) throw new Error(`MinIO setup did not provide ${name}`);
  return value;
}

function startRuntime(mode: "direct" | "proxy", prefix: string, webDist: string): ChildProcess {
  return spawn(process.execPath, ["dist/index.js"], {
    cwd: serverDir,
    env: {
      PATH: process.env.PATH,
      PORT: "0",
      PUBLIC_URL: "http://localhost",
      S3_ENDPOINT: required("S3_ENDPOINT"),
      S3_REGION: required("S3_REGION"),
      S3_BUCKET: required("S3_BUCKET"),
      S3_ACCESS_KEY_ID: required("S3_ACCESS_KEY_ID"),
      S3_SECRET_ACCESS_KEY: required("S3_SECRET_ACCESS_KEY"),
      S3_FORCE_PATH_STYLE: required("S3_FORCE_PATH_STYLE"),
      S3_PREFIX: prefix,
      PNEUMO_SETUP_TOKEN: SETUP_TOKEN,
      UPLOAD_MODE: mode,
      WEB_DIST_DIR: webDist,
      LOG_LEVEL: "info",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function runtimePort(child: ChildProcess): Promise<{ port: number; output: () => string }> {
  const listening = Promise.withResolvers<number>();
  let output = "";
  let parsedLength = 0;
  const accept = (chunk: Buffer) => {
    output += chunk.toString();
    const completeLength = output.lastIndexOf("\n") + 1;
    if (completeLength <= parsedLength) return;
    for (const line of output.slice(parsedLength, completeLength).split("\n")) {
      if (!line) continue;
      try {
        const row = JSON.parse(line) as { msg?: string; port?: number };
        if (row.msg === "Server listening" && typeof row.port === "number") {
          listening.resolve(row.port);
        }
      } catch {
        // Retain all child output for redaction assertions, but never print it.
      }
    }
    parsedLength = completeLength;
  };
  child.stdout?.on("data", accept);
  child.stderr?.on("data", accept);
  child.once("error", () => listening.reject(new Error("Server failed to start")));
  child.once("exit", () => listening.reject(new Error("Server exited before listening")));
  const timer = setTimeout(() => listening.reject(new Error("Server did not start")), 15_000);
  try {
    return { port: await listening.promise, output: () => output };
  } finally {
    clearTimeout(timer);
  }
}

async function stopRuntime(
  child: ChildProcess,
): Promise<[code: number | null, signal: NodeJS.Signals | null]> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return [child.exitCode, child.signalCode];
  }
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    return (await exited) as [number | null, NodeJS.Signals | null];
  } finally {
    clearTimeout(timer);
  }
}

type SmokeResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

async function runSmoke(
  origin: string,
  session: string,
  initialize: boolean,
): Promise<SmokeResult> {
  const child = spawn(
    "pnpm",
    [
      "--silent",
      "dev-client",
      "smoke",
      "--url",
      origin,
      ...(initialize ? ["--setup-token", SETUP_TOKEN] : ["--passphrase", PASSPHRASE]),
      "--session",
      session,
    ],
    {
      cwd: repositoryDir,
      env: process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const failed = Promise.withResolvers<never>();
  child.once("error", () => failed.reject(new Error("Dev client failed to start")));
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid) process.kill(-child.pid, "SIGKILL");
  }, 120_000);
  try {
    const [code, signal] = (await Promise.race([once(child, "exit"), failed.promise])) as [
      number | null,
      NodeJS.Signals | null,
    ];
    return { code, signal, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

function expectSmokePasses(result: SmokeResult): void {
  expect(result.timedOut).toBe(false);
  expect(result.code).toBe(0);
  expect(result.signal).toBeNull();
  const lines = result.stdout.split(/\r?\n/u).filter(Boolean);
  const allowed: ReadonlySet<string> = new Set(STEPS.map((step) => `PASS ${step}`));
  for (const step of STEPS) expect(lines.includes(`PASS ${step}`)).toBe(true);
  expect(lines.every((line) => allowed.has(line))).toBe(true);
  expect(result.stderr.length === 0).toBe(true);
}

for (const mode of ["direct", "proxy"] as const) {
  test(`dev-client setup and login smoke runs pass in ${mode} upload mode`, async () => {
    const temporary = await mkdtemp(join(tmpdir(), `pneumo-smoke-${mode}-`));
    const setupSessionPath = join(temporary, "setup-session.json");
    const loginSessionPath = join(temporary, "login-session.json");
    let child: ChildProcess | undefined;
    try {
      await writeFile(join(temporary, "index.html"), "<!doctype html>");
      child = startRuntime(mode, `eng256/smoke/${mode}/${randomUUID()}/`, temporary);
      const running = await runtimePort(child);
      const origin = `http://localhost:${running.port}`;
      const setupResult = await runSmoke(origin, setupSessionPath, true);
      const loginResult = await runSmoke(origin, loginSessionPath, false);
      const [serverCode, serverSignal] = await stopRuntime(child);
      child = undefined;

      expect(serverCode).toBe(0);
      expect(serverSignal).toBeNull();
      expectSmokePasses(setupResult);
      expectSmokePasses(loginResult);

      const setupSession = JSON.parse(await readFile(setupSessionPath, "utf8")) as {
        token?: unknown;
        mk?: unknown;
      };
      const loginSession = JSON.parse(await readFile(loginSessionPath, "utf8")) as {
        token?: unknown;
        mk?: unknown;
      };
      for (const session of [setupSession, loginSession]) {
        expect(typeof session.token === "string").toBe(true);
        expect(typeof session.mk === "string").toBe(true);
      }
      const clientOutput = [
        setupResult.stdout,
        setupResult.stderr,
        loginResult.stdout,
        loginResult.stderr,
      ].join("");
      const serverOutput = running.output();
      const sensitive = [
        SETUP_TOKEN,
        PASSPHRASE,
        origin,
        required("S3_ENDPOINT"),
        required("S3_ACCESS_KEY_ID"),
        required("S3_SECRET_ACCESS_KEY"),
        setupSession.token,
        setupSession.mk,
        loginSession.token,
        loginSession.mk,
      ];
      expect(
        sensitive.every((value) => typeof value !== "string" || !clientOutput.includes(value)),
      ).toBe(true);
      expect(
        sensitive.every((value) => typeof value !== "string" || !serverOutput.includes(value)),
      ).toBe(true);
    } finally {
      try {
        if (child) await stopRuntime(child);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
  }, 300_000);
}
