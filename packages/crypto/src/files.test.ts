import { ciphertextSize, FILE_AAD_PREFIX, FILE_CHUNK_SIZE, FILE_HEADER } from "@pneumo/protocol";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { createFileDecryptor, createFileEncryptor, decryptBlob, encryptBlob } from "./index.js";

const fileId = "019a33b0-4200-7000-8000-000000000010";
const otherFileId = "019a33b0-4200-7000-8000-000000000011";
const fk = patternedBytes(32, 0x245);
const header = new Uint8Array(FILE_HEADER);
const encoder = new TextEncoder();

function patternedBytes(length: number, seed: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  let state = seed | 0;
  for (let index = 0; index < bytes.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const joined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

function chunkedStream(
  bytes: Uint8Array,
  chunkSize: number,
  includeEmptyChunks = false,
): ReadableStream<Uint8Array> {
  let offset = 0;
  let emptyDue = includeEmptyChunks;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emptyDue) {
        emptyDue = false;
        controller.enqueue(new Uint8Array());
        return;
      }
      if (offset === bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.length);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
      emptyDue = includeEmptyChunks;
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const result = await reader.read();
    if (result.done) return concat(chunks);
    chunks.push(result.value);
  }
}

async function transformBytes(
  bytes: Uint8Array,
  chunkSize: number,
  transform: TransformStream<Uint8Array, Uint8Array>,
  includeEmptyChunks = false,
): Promise<Uint8Array<ArrayBuffer>> {
  return collect(chunkedStream(bytes, chunkSize, includeEmptyChunks).pipeThrough(transform));
}

async function encryptBytes(
  bytes: Uint8Array,
  chunkSize = Math.max(1, bytes.length),
  includeEmptyChunks = false,
): Promise<Uint8Array<ArrayBuffer>> {
  return transformBytes(bytes, chunkSize, createFileEncryptor(fk, fileId), includeEmptyChunks);
}

async function decryptBytes(
  bytes: Uint8Array,
  chunkSize = Math.max(1, bytes.length),
  id = fileId,
  key: Uint8Array = fk,
  includeEmptyChunks = false,
): Promise<Uint8Array<ArrayBuffer>> {
  return transformBytes(bytes, chunkSize, createFileDecryptor(key, id), includeEmptyChunks);
}

function fileNonce(index: bigint, last: boolean): Uint8Array<ArrayBuffer> {
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setBigUint64(3, index, false);
  nonce[11] = last ? 1 : 0;
  return nonce;
}

async function encryptBlock(
  key: CryptoKey,
  index: bigint,
  last: boolean,
  plaintext: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: fileNonce(index, last),
        additionalData: encoder.encode(FILE_AAD_PREFIX + fileId),
      },
      key,
      plaintext,
    ),
  );
}

describe("file Blob helpers", () => {
  test.each([0, 1, 15, 16, 65_535, 65_536, 65_537, 131_071, 131_072, 131_073, 200_000, 300_000])(
    "round-trips the exact %i-byte boundary",
    async (size) => {
      const plaintext = patternedBytes(size, size ^ 0x51f15e);
      const encrypted = await encryptBlob(fk, fileId, new Blob([plaintext]));
      const decrypted = await decryptBlob(fk, fileId, encrypted);
      expect(encrypted.size).toBe(ciphertextSize(size));

      expect(new Uint8Array(await decrypted.arrayBuffer())).toEqual(plaintext);
    },
  );

  test("round-trips random file sizes from zero through 300 KB", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 300_000 }), fc.integer(), async (size, seed) => {
        const plaintext = patternedBytes(size, seed);
        const encrypted = await encryptBlob(fk, fileId, new Blob([plaintext]));
        const decrypted = await decryptBlob(fk, fileId, encrypted);
        expect(new Uint8Array(await decrypted.arrayBuffer())).toEqual(plaintext);
      }),
      { numRuns: 16, seed: 245 },
    );
  }, 30_000);
});

describe("file streams", () => {
  test("is deterministic across 1, 7, 65536, and 100000-byte input splits and decrypts across independent splits", async () => {
    const plaintext = patternedBytes(FILE_CHUNK_SIZE + 37, 0x61e7);
    const reference = await encryptBytes(plaintext, 100_000, true);

    for (const chunkSize of [1, 7, 65_536, 100_000]) {
      const encrypted = await encryptBytes(plaintext, chunkSize);
      expect(encrypted).toEqual(reference);
      await expect(decryptBytes(reference, chunkSize)).resolves.toEqual(plaintext);
    }
    await expect(decryptBytes(reference, 7, fileId, fk, true)).resolves.toEqual(plaintext);
  }, 30_000);

  test("accepts empty chunks and represents an empty file as one authenticated empty block", async () => {
    const encrypted = await encryptBytes(new Uint8Array(), 1, true);

    expect(encrypted.subarray(0, FILE_HEADER.length)).toEqual(header);
    expect(encrypted).toHaveLength(FILE_HEADER.length + 16);
    await expect(decryptBytes(encrypted, 1, fileId, fk, true)).resolves.toEqual(new Uint8Array());
  });

  test("rejects every individual byte mutation of a small encrypted stream", async () => {
    const encrypted = await encryptBytes(new Uint8Array([1, 2, 3, 4]));

    for (let index = 0; index < encrypted.length; index += 1) {
      const changed = encrypted.slice();
      changed[index] = (changed[index] ?? 0) ^ 1;
      await expect(decryptBytes(changed, 3)).rejects.toThrow();
    }
  });

  test("rejects every complete-block truncation of a multi-block stream, including header-only", async () => {
    const plaintext = patternedBytes(FILE_CHUNK_SIZE * 2 + 11, 0x7a11);
    const encrypted = await encryptBytes(plaintext, 100_000);
    const encryptedBlockSize = FILE_CHUNK_SIZE + 16;

    for (const length of [
      0,
      FILE_HEADER.length,
      FILE_HEADER.length + encryptedBlockSize,
      FILE_HEADER.length + encryptedBlockSize * 2,
    ]) {
      await expect(decryptBytes(encrypted.subarray(0, length), 100_000)).rejects.toThrow();
    }
  });

  test.each([1, 16, FILE_CHUNK_SIZE + 16])("rejects %i appended bytes", async (extraLength) => {
    const encrypted = await encryptBytes(patternedBytes(FILE_CHUNK_SIZE + 3, 0xadd));
    const appended = concat([encrypted, patternedBytes(extraLength, extraLength)]);
    await expect(decryptBytes(appended, 7)).rejects.toThrow();
  });

  test("binds ciphertext to the file ID and file key", async () => {
    const encrypted = await encryptBytes(patternedBytes(100, 0xaad));

    await expect(decryptBytes(encrypted, 7, otherFileId)).rejects.toThrow();
    await expect(decryptBytes(encrypted, 7, fileId, patternedBytes(32, 0xbad))).rejects.toThrow();
  });

  test.each([
    ["magic", 0, 0],
    ["version", 4, 2],
    ["reserved header byte", 5, 1],
  ])("rejects a wrong %s", async (_rule, offset, value) => {
    const encrypted = await encryptBytes(new Uint8Array([1]));
    encrypted[offset] = value;
    await expect(decryptBytes(encrypted, 1)).rejects.toThrow();
  });

  test.each([0, 1, 2, 15])("rejects a final encrypted block of only %i bytes", async (size) => {
    const malformed = concat([header, new Uint8Array(size)]);
    await expect(decryptBytes(malformed, 1)).rejects.toThrow();
  });

  test("rejects an authenticated empty final chunk after an earlier chunk", async () => {
    const key = await crypto.subtle.importKey("raw", fk, "AES-GCM", false, ["encrypt"]);
    const first = await encryptBlock(key, 0n, false, patternedBytes(FILE_CHUNK_SIZE, 0xf1a1));
    const forbiddenEmptyFinal = await encryptBlock(key, 1n, true, new Uint8Array());
    const malicious = concat([header, first, forbiddenEmptyFinal]);

    await expect(decryptBytes(malicious, 100_000)).rejects.toThrow();
  });
});
