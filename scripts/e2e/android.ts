import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as httpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ListDevicesResponse } from "@pneumo/protocol";
import { Client } from "../pneumo-dev/client.js";
import { readSession } from "../pneumo-dev/session.js";
import { startMinio, stopMinio } from "./minio.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const android = join(root, "apps/android");
const outputDirectory = join(android, "build/e2e");
const adb = join(process.env.ANDROID_HOME ?? "", "platform-tools/adb");
const packageName = "dev.pneumo.app";
const configName = "pneumo-e2e.json";
const sendBackBody = "Managed Android real-server send back";
const children = new Set<ChildProcess>();
const sensitive = new Set<string>();
const captured: string[] = [];
const controller = new AbortController();
let leaked = false;
let serial: string | undefined;

function safeOutput(text: string): string {
  let safe = text;
  for (const value of sensitive) {
    if (safe.includes(value)) {
      leaked = true;
      safe = safe.replaceAll(value, "[REDACTED]");
    }
  }
  return safe;
}

interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  echo?: boolean;
  privateOutput?: boolean;
}

interface RunningCommand {
  process: ChildProcess;
  done: Promise<number | null>;
  stdout(): string;
  stderr(): string;
}

function child(command: string, args: string[], options: CommandOptions = {}): RunningCommand {
  const process = spawn(command, args, {
    cwd: options.cwd ?? root,
    env: options.env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(process);
  let stdout = "";
  let stderr = "";
  const pending = { stdout: "", stderr: "" };
  const accept = (chunk: Buffer, error: boolean) => {
    const text = chunk.toString();
    if (error) stderr += text;
    else stdout += text;
    if (!options.echo) return;
    const stream = error ? "stderr" : "stdout";
    pending[stream] += text;
    const end = pending[stream].lastIndexOf("\n") + 1;
    globalThis.process.stdout.write(safeOutput(pending[stream].slice(0, end)));
    pending[stream] = pending[stream].slice(end);
  };
  process.stdout.on("data", (chunk: Buffer) => accept(chunk, false));
  process.stderr.on("data", (chunk: Buffer) => accept(chunk, true));
  process.stdin.on("error", () => {});
  process.stdin.end(options.input);
  const { promise: done, resolve } = Promise.withResolvers<number | null>();
  process.once("error", () => resolve(-1));
  process.once("close", (code) => {
    children.delete(process);
    if (options.echo) globalThis.process.stdout.write(safeOutput(pending.stdout + pending.stderr));
    captured.push(...(options.privateOutput ? [stderr] : [stdout, stderr]));
    resolve(code);
  });
  return { process, done, stdout: () => stdout, stderr: () => stderr };
}

function signal(child: ChildProcess, value: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function stop(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null || !process.pid) return;
  const closed = once(process, "close");
  signal(process, "SIGTERM");
  const timer = setTimeout(() => signal(process, "SIGKILL"), 5_000);
  try {
    await closed;
  } finally {
    clearTimeout(timer);
  }
}

async function run(
  command: string,
  args: string[],
  options: CommandOptions = {},
  timeout = 120_000,
): Promise<string> {
  const running = child(command, args, options);
  const abort = () => signal(running.process, "SIGTERM");
  controller.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => signal(running.process, "SIGKILL"), timeout);
  try {
    assert.equal(await running.done, 0, `${command === adb ? "adb" : command} command failed`);
    return running.stdout().trim();
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", abort);
  }
}

async function poll(
  predicate: () => Promise<boolean>,
  timeout: number,
  description: string,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    controller.signal.throwIfAborted();
    if (await predicate()) return;
    await delay(250, undefined, { signal: controller.signal });
  }
  throw new Error(`Timed out: ${description}`);
}

async function port(): Promise<number> {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  assert(address && typeof address !== "string", "Random port allocation failed");
  const closed = Promise.withResolvers<void>();
  socket.close((error) => (error ? closed.reject(error) : closed.resolve()));
  await closed.promise;
  return address.port;
}

async function device(args: string[], options: CommandOptions = {}): Promise<string> {
  assert(serial, "Managed device not discovered");
  return run(adb, ["-s", serial, ...args], options, 15_000);
}

async function artifacts(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await artifacts(path)));
    else if (/\.(xml|txt|log|html|json)$/u.test(entry.name)) result.push(path);
  }
  return result;
}

async function main(): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  const temporary = await mkdtemp(join(tmpdir(), "pneumo-android-"));
  const cleanup: (() => Promise<unknown>)[] = [];
  let sendBackVerified = false;
  let dozeVerified = false;
  const interrupt = () => controller.abort(new Error("Android smoke interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    assert.equal(
      await run(adb, ["devices"]).then(
        (text) => text.split("\n").filter((line) => /^emulator-\d+\s/u.test(line)).length,
      ),
      0,
      "Stop other emulators before the managed-device suite",
    );
    cleanup.push(async () => {
      const connected = await run(adb, ["devices"]);
      serial ??= /^((?:emulator-)\d+)\s+device$/mu.exec(connected)?.[1];
      if (!serial || !connected.includes(`${serial}\tdevice`)) return;
      try {
        await device(["shell", "dumpsys", "deviceidle", "unforce"]);
        await device(["shell", "dumpsys", "battery", "reset"]);
        await device(["shell", "am", "force-stop", packageName]);
        await device(["emu", "kill"]);
      } catch (error) {
        // Gradle owns shutdown too and may remove the device between adb commands.
        if ((await run(adb, ["devices"])).includes(`${serial}\tdevice`)) throw error;
      }
    });
    await run("pnpm", ["--filter", "@pneumo/server", "build"], { echo: true });
    const previousInterrupts = new Set(process.listeners("SIGINT"));
    const minio = await startMinio();
    // This owner must stop the emulator/server as well; MinIO's standalone handler exits early.
    for (const listener of process.listeners("SIGINT")) {
      if (!previousInterrupts.has(listener)) process.removeListener("SIGINT", listener);
    }
    cleanup.push(() => stopMinio(minio));
    const serverPort = await port();
    const hostOrigin = `http://localhost:${serverPort}`;
    const emulatorOrigin = `http://10.0.2.2:${serverPort}`;
    const setupToken = randomBytes(32).toString("hex");
    const passphrase = randomBytes(32).toString("hex");
    sensitive.add(setupToken).add(passphrase);
    const server = child(process.execPath, ["dist/index.js"], {
      cwd: join(root, "apps/server"),
      env: {
        PATH: process.env.PATH,
        ...minio.env,
        PORT: String(serverPort),
        PUBLIC_URL: emulatorOrigin,
        UPLOAD_MODE: "proxy",
        PNEUMO_SETUP_TOKEN: setupToken,
        S3_PREFIX: `android/${randomBytes(12).toString("hex")}/`,
        WEB_DIST_DIR: temporary,
        LOG_LEVEL: "info",
      },
    });
    cleanup.push(() => stop(server.process));
    await poll(
      async () => {
        assert(server.process.exitCode === null, "Built server exited before listening");
        return server
          .stdout()
          .split("\n")
          .some((line) => {
            try {
              const event = JSON.parse(line) as { msg?: string; port?: number };
              return event.msg === "Server listening" && event.port === serverPort;
            } catch {
              return false;
            }
          });
      },
      30_000,
      "structured Server listening event",
    );
    assert((await fetch(`${hostOrigin}/api/health`)).ok, "Built server health failed");
    console.log("PASS built server and isolated MinIO (proxy)");
    const ownerPath = join(temporary, "owner.json");
    const senderPath = join(temporary, "sender.json");
    const cli = (args: string[]) => run("pnpm", ["--silent", "dev-client", ...args]);
    await cli([
      "setup",
      "--url",
      hostOrigin,
      "--setup-token",
      setupToken,
      "--passphrase",
      passphrase,
      "--session",
      ownerPath,
    ]);
    const owner = await readSession(ownerPath);
    sensitive.add(owner.token).add(owner.mk);
    const hostPairUri = await run(
      "pnpm",
      ["--silent", "dev-client", "pair-uri", "--session", ownerPath],
      { privateOutput: true },
    );
    const emulatorPairUri = new URL(hostPairUri);
    emulatorPairUri.searchParams.set("u", emulatorOrigin);
    const pairUri = emulatorPairUri.toString();
    sensitive.add(hostPairUri).add(pairUri);
    await cli([
      "login",
      "--url",
      hostOrigin,
      "--passphrase",
      passphrase,
      "--name",
      "cli",
      "--session",
      senderPath,
    ]);
    const sender = await readSession(senderPath);
    sensitive.add(sender.token).add(sender.mk);
    const client = new Client(sender);
    let waiter: RunningCommand | undefined;
    const coordinator = httpServer((request, response) => {
      void (async () => {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (url.pathname === "/send-back-ready") {
          assert(!waiter, "Send-back waiter started twice");
          waiter = child("pnpm", [
            "--silent",
            "dev-client",
            "wait-for",
            "--type",
            "note",
            "--body",
            sendBackBody,
            "--timeout",
            "90",
            "--session",
            senderPath,
          ]);
          await poll(
            async () => {
              const { devices } = await client.api("/api/devices", ListDevicesResponse);
              return devices.some((entry) => entry.id === sender.deviceId && entry.online);
            },
            30_000,
            "dev-client authenticated hello",
          );
        } else if (url.pathname === "/send-back-received") {
          assert(waiter, "Send-back waiter was not started");
          assert.equal(await waiter.done, 0, "dev-client wait-for failed");
          const push = JSON.parse(waiter.stdout()) as {
            type: string;
            body: string;
            source: string;
          };
          assert(
            push.type === "note" &&
              push.body === sendBackBody &&
              push.source !== sender.deviceId &&
              push.source !== owner.deviceId,
            "Send-back payload/source mismatch",
          );
          sendBackVerified = true;
          console.log("PASS Home composer received by dev-client wait-for");
        } else if (url.pathname === "/doze") {
          await device(["shell", "input", "keyevent", "KEYCODE_SLEEP"]);
          await device(["shell", "dumpsys", "battery", "unplug"]);
          // ATD disables deep idle by default; enable it before exercising forced Doze.
          await device(["shell", "dumpsys", "deviceidle", "enable"]);
          try {
            await device(["shell", "dumpsys", "deviceidle", "force-idle"]);
            assert.equal(
              await device(["shell", "dumpsys", "deviceidle", "get", "deep"]),
              "IDLE",
              "Managed device did not enter forced Doze",
            );
            await client.send({
              type: "note",
              title: "E2E background note",
              body: "Delivered after forced Doze",
            });
          } finally {
            await device(["shell", "dumpsys", "deviceidle", "unforce"]);
            await device(["shell", "dumpsys", "battery", "reset"]);
            await device(["shell", "input", "keyevent", "KEYCODE_WAKEUP"]);
          }
          dozeVerified = true;
          console.log("PASS forced Doze send and unforce");
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ title: "E2E background note" }));
          return;
        } else if (
          url.pathname === "/stage" &&
          /^[A-Za-z0-9 _-]{1,80}$/u.test(url.searchParams.get("name") ?? "")
        ) {
          console.log(`ANDROID ${url.searchParams.get("name")}`);
        } else {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(204).end();
      })().catch(() => {
        response.writeHead(500).end("Android harness operation failed");
      });
    });
    coordinator.listen(0, "0.0.0.0");
    await once(coordinator, "listening");
    cleanup.push(async () => {
      coordinator.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      coordinator.close(() => closed.resolve());
      await closed.promise;
    });
    const address = coordinator.address();
    assert(address && typeof address !== "string", "Coordinator did not listen");
    const config = JSON.stringify({
      pairUri,
      sender: { ...sender, url: emulatorOrigin },
      sendBackBody,
    });
    const gradle = child(
      join(android, "gradlew"),
      [
        "-p",
        android,
        "pixel6Api34DebugAndroidTest",
        "--rerun",
        "--no-daemon",
        "--console=plain",
        `-Pandroid.testInstrumentationRunnerArguments.pneumoHarness=http://10.0.2.2:${address.port}`,
      ],
      { echo: true },
    );
    const cancelGradle = () => signal(gradle.process, "SIGTERM");
    controller.signal.addEventListener("abort", cancelGradle, { once: true });
    cleanup.push(async () => {
      controller.signal.removeEventListener("abort", cancelGradle);
      await stop(gradle.process);
    });
    await poll(
      async () => {
        assert(gradle.process.exitCode === null, "Gradle exited before managed-device startup");
        const devices = await run(adb, ["devices"]);
        serial = /^((?:emulator-)\d+)\s+device$/mu.exec(devices)?.[1];
        if (!serial) return false;
        const installed = child(adb, ["-s", serial, "shell", "run-as", packageName, "pwd"]);
        return (await installed.done) === 0;
      },
      300_000,
      "managed-device app installation",
    );
    assert(serial, "Managed device disappeared before credential transfer");
    const logcat = child(adb, ["-s", serial, "logcat", "-v", "brief"]);
    cleanup.push(() => stop(logcat.process));
    await device(
      [
        "shell",
        "run-as",
        packageName,
        "sh",
        "-c",
        `"umask 077; mkdir -p files; cat > files/${configName}.tmp; mv files/${configName}.tmp files/${configName}"`,
      ],
      { input: config },
    );
    console.log("PASS private device credential file; no secret runner arguments");
    const gradleTimeout = setTimeout(() => signal(gradle.process, "SIGTERM"), 600_000);
    let code: number | null;
    try {
      code = await gradle.done;
    } finally {
      clearTimeout(gradleTimeout);
    }
    await stop(logcat.process);
    assert.equal(code, 0, "Managed-device suite failed");
    assert(
      sendBackVerified && dozeVerified,
      "Real-server smoke did not complete harness handshakes",
    );
    console.log("PASS managed-device suite including real-server smoke");
  } finally {
    let cleanupFailed = false;
    for (const close of cleanup.reverse()) {
      try {
        await close();
      } catch {
        cleanupFailed = true;
      }
    }
    for (const process of [...children]) await stop(process);
    await rm(temporary, { recursive: true, force: true });
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    for (const path of await artifacts(join(android, "app/build/outputs")))
      captured.push(await readFile(path, "utf8"));
    for (const path of await artifacts(join(android, "app/build/reports/androidTests")))
      captured.push(await readFile(path, "utf8"));
    const safe = safeOutput(captured.join("\n"));
    await writeFile(join(outputDirectory, "last-run.log"), safe, { mode: 0o600 });
    console.log(
      `Secret scan (Gradle, instrumentation results, server, logcat): ${leaked ? "FAIL" : "0 matches"}`,
    );
    assert(!leaked, "Credential material appeared in captured output (redacted in saved log)");
    assert(!cleanupFailed, "Android smoke cleanup failed");
    console.log("PASS emulator, server, MinIO and credential cleanup");
  }
}

main().catch((error: unknown) => {
  // Never propagate child diagnostics: command errors can contain credentials.
  console.error(
    error instanceof assert.AssertionError
      ? error.message.split("\n")[0]
      : "Android real-server smoke failed",
  );
  process.exitCode = 1;
});
