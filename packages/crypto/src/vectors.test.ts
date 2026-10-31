import { expect, test } from "vitest";
import {
  findPortableSourceViolations,
  readCommittedVectors,
  runPythonCrosscheck,
} from "../scripts/vector-test-helpers.js";
import { buildVectors, serializeVectors, vectorPlaintext } from "../scripts/vectors.js";
import { b64uDecode, b64uEncode, decryptBlob, decryptPush, deriveKeys } from "./index.js";

const generatedVectorsPromise = buildVectors();
const committedVectorsPromise = readCommittedVectors();

function xorByte(bytes: Uint8Array<ArrayBuffer>, index: number, value: number): void {
  const original = bytes[index];
  if (original === undefined) {
    throw new Error(`Vector mutation index ${index} is out of bounds`);
  }
  bytes[index] = original ^ value;
}

function appendBytes(
  left: Uint8Array<ArrayBuffer>,
  right: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}

test("committed vectors are byte-for-byte fresh", async () => {
  const [generated, committed] = await Promise.all([
    generatedVectorsPromise,
    committedVectorsPromise,
  ]);
  expect(
    (await serializeVectors(generated)) === committed.text,
    "Vectors are stale; run `pnpm --filter @pneumo/crypto vectors:generate`",
  ).toBe(true);
}, 30_000);

test("all crypto sources stay runtime-portable", async () => {
  expect(await findPortableSourceViolations()).toEqual([]);
});

test("stdlib Python independently cross-checks every key vector", async () => {
  await runPythonCrosscheck();
}, 30_000);

test("generated KDF, HKDF, key-check, and auth-key products match every committed vector", async () => {
  const [generated, { vectors: committed }] = await Promise.all([
    generatedVectorsPromise,
    committedVectorsPromise,
  ]);

  for (const section of ["kdf", "hkdf", "keyCheck", "authKey"] as const) {
    expect(generated[section], section).toEqual(committed[section]);
  }

  const composed = committed.kdf.find((item) => item.name === "fast-nfc-composed-1000");
  const decomposed = committed.kdf.find((item) => item.name === "fast-nfc-decomposed-1000");
  expect(composed?.masterKey).toBe(decomposed?.masterKey);
}, 30_000);

test("decrypts every committed AES-GCM envelope", async () => {
  const { vectors } = await committedVectorsPromise;
  const contentKeys = new Map<string, CryptoKey>();

  for (const item of vectors.envelope) {
    let contentKey = contentKeys.get(item.masterKey);
    if (contentKey === undefined) {
      contentKey = (await deriveKeys(b64uDecode(item.masterKey))).contentKey;
      contentKeys.set(item.masterKey, contentKey);
    }
    expect(item.envelope.n, item.name).toBe(item.nonce);
    await expect(decryptPush(contentKey, item.pushId, item.envelope), item.name).resolves.toEqual(
      item.payload,
    );
  }
});

test("decrypts every committed full file ciphertext and checks every file product", async () => {
  const [{ vectors }, generated] = await Promise.all([
    committedVectorsPromise,
    generatedVectorsPromise,
  ]);
  const fileKey = b64uDecode(vectors.file.key);

  expect(generated.file.cases).toEqual(vectors.file.cases);
  for (const item of vectors.file.cases) {
    if (item.ciphertext === undefined) {
      expect(item.sha256, item.name).toMatch(/^[A-Za-z0-9_-]{43}$/);
      continue;
    }
    const ciphertext = b64uDecode(item.ciphertext);
    expect(ciphertext.byteLength, item.name).toBe(item.ciphertextLength);
    const plaintext = new Uint8Array(
      await (await decryptBlob(fileKey, vectors.file.fileId, new Blob([ciphertext]))).arrayBuffer(),
    );
    expect(plaintext, item.name).toEqual(vectorPlaintext(item.size));
  }
});

test("every documented negative vector rejects", async () => {
  const { vectors } = await committedVectorsPromise;
  const fileKey = b64uDecode(vectors.file.key);
  const contentKeys = new Map<string, CryptoKey>();

  for (const item of vectors.negative) {
    expect(item.expected, item.name).toBe("reject");
    if (item.operation === "decryptPush") {
      const source = vectors.envelope.find((candidate) => candidate.name === item.source.name);
      if (source === undefined) {
        throw new Error(`Missing envelope source for ${item.name}`);
      }
      let contentKey = contentKeys.get(source.masterKey);
      if (contentKey === undefined) {
        contentKey = (await deriveKeys(b64uDecode(source.masterKey))).contentKey;
        contentKeys.set(source.masterKey, contentKey);
      }
      let pushId = source.pushId;
      let envelope = source.envelope;
      if (item.mutation.type === "xor-last-byte") {
        const ciphertext = b64uDecode(source.envelope.c);
        xorByte(ciphertext, ciphertext.byteLength - 1, item.mutation.xor);
        envelope = { ...source.envelope, c: b64uEncode(ciphertext) };
      } else {
        pushId = item.mutation.value;
      }
      await expect(decryptPush(contentKey, pushId, envelope), item.name).rejects.toThrow();
      continue;
    }

    const source = vectors.file.cases.find((candidate) => candidate.size === item.source.size);
    if (source?.ciphertext === undefined) {
      throw new Error(`Missing full file source for ${item.name}`);
    }
    let ciphertext = b64uDecode(source.ciphertext);
    let fileId = vectors.file.fileId;
    switch (item.mutation.type) {
      case "xor-last-byte":
        xorByte(ciphertext, ciphertext.byteLength - 1, item.mutation.xor);
        break;
      case "truncate":
        ciphertext = ciphertext.slice(0, item.mutation.length);
        break;
      case "append":
        ciphertext = appendBytes(ciphertext, b64uDecode(item.mutation.bytes));
        break;
      case "replace-file-id":
        fileId = item.mutation.value;
        break;
      case "xor-byte":
        xorByte(ciphertext, item.mutation.index, item.mutation.xor);
        break;
    }
    await expect(decryptBlob(fileKey, fileId, new Blob([ciphertext])), item.name).rejects.toThrow();
  }
});
