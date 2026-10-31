import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { b64uEncode, deriveKeys, encryptPush, parsePairingUri } from "@pneumo/crypto";
import { uuidv7 } from "@pneumo/protocol";
import { afterAll, beforeAll, expect, test } from "vitest";
import { run } from "../pneumo-dev.js";
import { Client } from "./client.js";
import { type Session, writeSession } from "./session.js";

const exec = promisify(execFile);
const token = b64uEncode(new Uint8Array(32).fill(7));
const mk = b64uEncode(new Uint8Array(32).fill(9));
const pairCode = b64uEncode(new Uint8Array(16).fill(3));
let directory: string;
let sessionPath: string;
let session: Session;
let rejectPair = false;
const server = createServer((request, response) => {
  response.setHeader("Content-Type", "application/json");
  if (request.url === "/api/pair" && request.method === "POST") {
    if (rejectPair) {
      response
        .writeHead(403)
        .end(JSON.stringify({ error: { code: "forbidden", message: `${token} ${mk}` } }));
    } else {
      response
        .writeHead(201)
        .end(JSON.stringify({ code: pairCode, expiresAt: "2026-10-31T12:00:00.000Z" }));
    }
    return;
  }
  response.writeHead(404).end("{}");
});

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "pneumo-output-test-"));
  sessionPath = join(directory, "session.json");
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  session = { url: `http://127.0.0.1:${address.port}`, deviceId: uuidv7(), token, mk };
  await writeSession(sessionPath, session);
});

afterAll(async () => {
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  server.closeAllConnections();
  await closed.promise;
  await rm(directory, { recursive: true, force: true });
});

test("pair-uri emits only a parseable pairing URI with the session master key", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(["pair-uri", "--session", sessionPath], {
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
  });
  expect(code).toBe(0);
  expect(stderr).toEqual([]);
  expect(stdout.length === 1).toBe(true);
  const parsed = parsePairingUri(stdout[0] ?? "");
  expect(
    parsed.origin === session.url && b64uEncode(parsed.mk) === mk && parsed.code === pairCode,
  ).toBe(true);
  expect(stdout.join("").includes(token)).toBe(false);
});

test("HTTP failure bodies never reach stdout or stderr", async () => {
  const output: string[] = [];
  rejectPair = true;
  try {
    const code = await run(["pair-uri", "--session", sessionPath], {
      out: (line) => output.push(line),
      err: (line) => output.push(line),
    });
    expect(code).toBe(1);
    expect(output.join("\n").includes(token) || output.join("\n").includes(mk)).toBe(false);
  } finally {
    rejectPair = false;
  }
});

test("decrypted file output contains the name and source but not the file key or session credentials", async () => {
  const key = b64uEncode(new Uint8Array(32).fill(11));
  const id = uuidv7();
  const { contentKey } = await deriveKeys(new Uint8Array(32).fill(9));
  const envelope = await encryptPush(contentKey, id, {
    type: "file",
    title: "Report",
    file: { name: "report.bin", mime: "application/octet-stream", size: 12, key },
  });
  const row = await new Client(session).decrypted({
    id,
    createdAt: "2026-10-31T12:00:00.000Z",
    sourceDeviceId: session.deviceId,
    targetDeviceId: null,
    envelope,
    file: { id: uuidv7(), size: 36 },
  });
  expect(row).toEqual({
    id,
    type: "file",
    title: "Report",
    fileName: "report.bin",
    source: session.deviceId,
  });
  const serialized = JSON.stringify(row);
  expect([key, token, mk].some((secret) => serialized.includes(secret))).toBe(false);
});

test("pnpm --silent does not echo credential-bearing command arguments", async () => {
  const sentinel = "fake-passphrase-must-not-be-echoed";
  let stdout = "";
  let stderr = "";
  let failed = false;
  try {
    await exec("pnpm", ["--silent", "dev-client", "claim", "--uri", sentinel], {
      cwd: new URL("../../", import.meta.url),
    });
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string; code?: number };
    stdout = result.stdout ?? "";
    stderr = result.stderr ?? "";
    failed = result.code === 1;
  }
  expect(failed).toBe(true);
  expect(stdout.includes(sentinel) || stderr.includes(sentinel)).toBe(false);
  expect(stdout).toBe("");
});
