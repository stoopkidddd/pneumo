import { FILE_CHUNK_SIZE, FILE_HEADER, MAX_OBJECT_TIMESTAMP_MS } from "./constants.js";

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PUSH_OBJECT_KEY_PATTERN = /^pushes\/(\d{13})_([^/]+)\.json$/;
const HTTP_URL_PATTERN = /^https?:\/\/\S+$/i;

export function uuidv7(): string {
  const timestamp = Date.now();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 0xffff_ffff_ffff) {
    throw new RangeError("The current timestamp is outside the UUIDv7 range");
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  let remainingTimestamp = timestamp;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = remainingTimestamp % 0x100;
    remainingTimestamp = Math.floor(remainingTimestamp / 0x100);
  }

  let id = "";
  let index = 0;
  for (const byte of bytes) {
    if (index === 4 || index === 6 || index === 8 || index === 10) id += "-";
    const value = index === 6 ? (byte & 0x0f) | 0x70 : index === 8 ? (byte & 0x3f) | 0x80 : byte;
    id += value.toString(16).padStart(2, "0");
    index += 1;
  }
  return id;
}

export function isUuidv7(value: unknown): value is string {
  return typeof value === "string" && UUID_V7_PATTERN.test(value);
}

export function pushObjectKey(createdAtMs: number, id: string): string {
  if (typeof createdAtMs !== "number") {
    throw new TypeError("createdAtMs must be a number");
  }
  if (
    !Number.isSafeInteger(createdAtMs) ||
    createdAtMs < 0 ||
    createdAtMs > MAX_OBJECT_TIMESTAMP_MS
  ) {
    throw new RangeError(
      `createdAtMs must be an integer from 0 through ${MAX_OBJECT_TIMESTAMP_MS}`,
    );
  }
  if (!isUuidv7(id)) {
    throw new TypeError("id must be a lowercase canonical UUIDv7");
  }

  const inverseTimestamp = MAX_OBJECT_TIMESTAMP_MS - createdAtMs;
  return `pushes/${inverseTimestamp.toString().padStart(13, "0")}_${id}.json`;
}

export function parsePushObjectKey(key: string): { createdAtMs: number; id: string } | null {
  if (typeof key !== "string") {
    return null;
  }

  const match = PUSH_OBJECT_KEY_PATTERN.exec(key);
  const inverseTimestampText = match?.[1];
  const id = match?.[2];
  if (inverseTimestampText === undefined || !isUuidv7(id)) {
    return null;
  }

  const inverseTimestamp = Number(inverseTimestampText);
  if (!Number.isSafeInteger(inverseTimestamp) || inverseTimestamp > MAX_OBJECT_TIMESTAMP_MS) {
    return null;
  }

  return {
    createdAtMs: MAX_OBJECT_TIMESTAMP_MS - inverseTimestamp,
    id,
  };
}

export function detectLink(text: string): boolean {
  if (typeof text !== "string") {
    return false;
  }

  const candidate = text.trim();
  if (!HTTP_URL_PATTERN.test(candidate)) {
    return false;
  }

  try {
    const url = new URL(candidate);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}

export function ciphertextSize(plainSize: number): number {
  if (typeof plainSize !== "number") {
    throw new TypeError("plainSize must be a number");
  }
  if (!Number.isSafeInteger(plainSize) || plainSize < 0) {
    throw new RangeError("plainSize must be a non-negative safe integer");
  }

  const chunkCount = Math.max(1, Math.ceil(plainSize / FILE_CHUNK_SIZE));
  const size = FILE_HEADER.length + plainSize + 16 * chunkCount;
  if (!Number.isSafeInteger(size)) {
    throw new RangeError("The ciphertext size exceeds the safe integer range");
  }

  return size;
}
