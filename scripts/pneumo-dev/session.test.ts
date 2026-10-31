import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { b64uEncode } from "@pneumo/crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SafeError } from "./errors.js";
import { readSession, type Session, writeSession } from "./session.js";

const DEVICE_ID = "019a33b0-4200-7000-8000-000000000001";
const TOKEN = b64uEncode(new Uint8Array(32).fill(11));
const MASTER_KEY = b64uEncode(new Uint8Array(32).fill(29));
const OLD_SECRET = "old-secret-that-must-not-remain";
const INVALID_SECRET = "invalid-secret-that-must-not-leak";
const VALID_SESSION: Session = {
  url: "https://pneumo.example.test",
  deviceId: DEVICE_ID,
  token: TOKEN,
  mk: MASTER_KEY,
};

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pneumo-dev-session-test-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function rejectsSafely(
  action: () => Promise<unknown>,
  sensitive: readonly string[] = [],
): Promise<boolean> {
  try {
    await action();
    return false;
  } catch (error) {
    return error instanceof SafeError && sensitive.every((value) => !error.message.includes(value));
  }
}

describe("session persistence", () => {
  test("writes and reads a validated session", async () => {
    const path = join(directory, "session.json");

    await writeSession(path, VALID_SESSION);
    const session = await readSession(path);

    expect(session.url).toBe(VALID_SESSION.url);
    expect(session.deviceId).toBe(DEVICE_ID);
    expect(session.token === TOKEN).toBe(true);
    expect(session.mk === MASTER_KEY).toBe(true);
  });

  test("atomically replaces old content and enforces mode 600", async () => {
    const path = join(directory, "session.json");
    await writeFile(path, OLD_SECRET, { mode: 0o666 });
    await chmod(path, 0o666);

    await writeSession(path, VALID_SESSION);

    const fileMode = (await stat(path)).mode & 0o777;
    const contents = await readFile(path, "utf8");
    const parsed = JSON.parse(contents) as Record<string, unknown>;
    expect(fileMode).toBe(0o600);
    expect(contents.includes(OLD_SECRET)).toBe(false);
    expect(parsed.token === TOKEN).toBe(true);
    expect(parsed.mk === MASTER_KEY).toBe(true);
  });

  test("replaces a destination symlink instead of following it", async () => {
    const target = join(directory, "target.json");
    const path = join(directory, "session.json");
    await writeFile(target, OLD_SECRET);
    await symlink(target, path);

    await writeSession(path, VALID_SESSION);

    const targetContents = await readFile(target, "utf8");
    const saved = await readSession(path);
    expect(targetContents === OLD_SECRET).toBe(true);
    expect(saved.token === TOKEN).toBe(true);
  });
});

describe("session validation and safe errors", () => {
  test("rejects malformed JSON without exposing file content", async () => {
    const path = join(directory, "session.json");
    await writeFile(path, `{${INVALID_SECRET}`);

    expect(await rejectsSafely(() => readSession(path), [INVALID_SECRET])).toBe(true);
  });

  test("rejects invalid fields and additional fields", async () => {
    const invalidTokenPath = join(directory, "invalid-token.json");
    const additionalFieldPath = join(directory, "additional-field.json");
    await writeFile(invalidTokenPath, JSON.stringify({ ...VALID_SESSION, token: INVALID_SECRET }));
    await writeFile(
      additionalFieldPath,
      JSON.stringify({ ...VALID_SESSION, extra: INVALID_SECRET }),
    );

    expect(await rejectsSafely(() => readSession(invalidTokenPath), [INVALID_SECRET])).toBe(true);
    expect(await rejectsSafely(() => readSession(additionalFieldPath), [INVALID_SECRET])).toBe(
      true,
    );
  });

  test("rejects invalid sessions before writing", async () => {
    const path = join(directory, "session.json");
    const invalid = { ...VALID_SESSION, mk: INVALID_SECRET };

    expect(await rejectsSafely(() => writeSession(path, invalid), [INVALID_SECRET])).toBe(true);
  });

  test("uses a safe error for missing files", async () => {
    const path = join(directory, INVALID_SECRET);

    expect(await rejectsSafely(() => readSession(path), [INVALID_SECRET])).toBe(true);
  });

  test("does not follow session symlinks when reading", async () => {
    const target = join(directory, "target.json");
    const path = join(directory, "session.json");
    await writeFile(target, JSON.stringify(VALID_SESSION));
    await symlink(target, path);

    expect(await rejectsSafely(() => readSession(path))).toBe(true);
  });
});
