import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { open, rename, unlink } from "node:fs/promises";
import { b64uDecode } from "@pneumo/crypto";
import { B64u, HttpUrl, Uuidv7 } from "@pneumo/protocol";
import { SafeError } from "./errors.js";

export interface Session {
  url: string;
  deviceId: string;
  token: string;
  mk: string;
}

const SESSION_KEYS = ["deviceId", "mk", "token", "url"] as const;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

function isEncodedKey(value: unknown): value is string {
  if (!B64u.safeParse(value).success) return false;
  try {
    return b64uDecode(value as string).byteLength === 32;
  } catch {
    return false;
  }
}

function validateSession(value: unknown): Session {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SafeError("Session file is invalid");
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== SESSION_KEYS.length ||
    keys.some((key, index) => key !== SESSION_KEYS[index])
  ) {
    throw new SafeError("Session file is invalid");
  }
  if (!HttpUrl.safeParse(record.url).success) throw new SafeError("Session file is invalid");
  if (!Uuidv7.safeParse(record.deviceId).success) throw new SafeError("Session file is invalid");
  if (!isEncodedKey(record.token) || !isEncodedKey(record.mk)) {
    throw new SafeError("Session file is invalid");
  }

  return {
    url: record.url as string,
    deviceId: record.deviceId as string,
    token: record.token,
    mk: record.mk,
  };
}

export async function readSession(path: string): Promise<Session> {
  let contents: string;
  try {
    const handle = await open(path, constants.O_RDONLY | NO_FOLLOW);
    try {
      contents = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    throw new SafeError("Unable to read session file");
  }

  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new SafeError("Session file is invalid");
  }
  return validateSession(value);
}
export async function writeSession(path: string, session: Session): Promise<void> {
  const validated = validateSession(session);
  const contents = `${JSON.stringify(validated)}\n`;
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;

  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    await handle.chmod(0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } catch {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await unlink(temporaryPath).catch(() => undefined);
    throw new SafeError("Unable to write session file");
  }
}
