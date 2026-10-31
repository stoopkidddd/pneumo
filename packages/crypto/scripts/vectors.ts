import type { Envelope, KdfParams, PushPayload } from "@pneumo/protocol";
import {
  DEFAULT_KDF_ITERATIONS,
  FILE_CHUNK_SIZE,
  FILE_HEADER,
  HKDF_LABELS,
} from "@pneumo/protocol";

import { b64uEncode, deriveKeys, deriveMasterKey, encryptBlob, keyCheck } from "../src/index.js";
import { deriveHkdf, encryptPushWithNonce } from "../src/internal.js";

export interface KdfVector {
  name: string;
  passphrase: string;
  params: KdfParams;
  masterKey: string;
}

export interface HkdfVector {
  name: string;
  masterKey: string;
  label: string;
  length: 32;
  output: string;
}

export interface KeyOutputVector {
  name: string;
  masterKey: string;
  output: string;
}

export interface EnvelopeVector {
  name: string;
  masterKey: string;
  pushId: string;
  nonce: string;
  payload: PushPayload;
  envelope: Envelope;
}

export interface FileVector {
  name: string;
  size: number;
  ciphertextLength: number;
  ciphertext?: string;
  sha256?: string;
}

export type NegativeVector =
  | {
      name: string;
      operation: "decryptPush";
      source: { section: "envelope"; name: string };
      mutation:
        | { type: "xor-last-byte"; field: "envelope.c"; xor: number }
        | { type: "replace-push-id"; value: string };
      expected: "reject";
    }
  | {
      name: string;
      operation: "decryptFile";
      source: { section: "file"; size: number };
      mutation:
        | { type: "xor-last-byte"; field: "ciphertext"; xor: number }
        | { type: "truncate"; length: number }
        | { type: "append"; bytes: string }
        | { type: "replace-file-id"; value: string }
        | { type: "xor-byte"; field: "ciphertext"; index: number; xor: number };
      expected: "reject";
    };

export interface CryptoVectors {
  $comment: string[];
  version: 1;
  kdf: KdfVector[];
  hkdf: HkdfVector[];
  keyCheck: KeyOutputVector[];
  authKey: KeyOutputVector[];
  envelope: EnvelopeVector[];
  file: {
    key: string;
    fileId: string;
    plaintextPattern: string;
    cases: FileVector[];
  };
  negative: NegativeVector[];
}

const FILE_ID = "0194f5d4-6c20-7a31-9abc-0123456789ab";
const PUSH_ID = "0194f5d4-6c20-7a31-9abc-0123456789ac";
const WRONG_FILE_ID = "0194f5d4-6c20-7a31-9abc-0123456789ad";
const WRONG_PUSH_ID = "0194f5d4-6c20-7a31-9abc-0123456789ae";
const FILE_SIZES = [0, 1, 65_535, 65_536, 65_537, 200_000] as const;
const FULL_CIPHERTEXT_MAX_SIZE = 65_537;
const FIRST_ENCRYPTED_CHUNK_BOUNDARY = FILE_HEADER.length + FILE_CHUNK_SIZE + 16;

function deterministicBytes(
  length: number,
  multiplier: number,
  increment: number,
): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = (index * multiplier + increment) & 0xff;
  }
  return bytes;
}

export function vectorPlaintext(size: number): Uint8Array<ArrayBuffer> {
  return deterministicBytes(size, 31, 17);
}

async function makeKdfVector(
  name: string,
  passphrase: string,
  iterations: number,
  salt: Uint8Array<ArrayBuffer>,
): Promise<{ vector: KdfVector; masterKey: Uint8Array<ArrayBuffer> }> {
  const params: KdfParams = {
    alg: "PBKDF2-SHA256",
    iterations,
    salt: b64uEncode(salt),
  };
  const masterKey = await deriveMasterKey(passphrase, params);
  return {
    vector: { name, passphrase, params, masterKey: b64uEncode(masterKey) },
    masterKey,
  };
}

export async function buildVectors(): Promise<CryptoVectors> {
  const productionKdf = await makeKdfVector(
    "production-600000",
    "fake vector passphrase",
    DEFAULT_KDF_ITERATIONS,
    deterministicBytes(16, 13, 7),
  );
  const fastAsciiKdf = await makeKdfVector(
    "fast-ascii-1000",
    "fake fast passphrase",
    1_000,
    deterministicBytes(16, 19, 3),
  );
  const fastNfcComposedKdf = await makeKdfVector(
    "fast-nfc-composed-1000",
    "Caf\u00e9 fake passphrase",
    1_000,
    deterministicBytes(16, 23, 11),
  );
  const fastNfcDecomposedKdf = await makeKdfVector(
    "fast-nfc-decomposed-1000",
    "Cafe\u0301 fake passphrase",
    1_000,
    deterministicBytes(16, 23, 11),
  );

  const masterKey = fastAsciiKdf.masterKey;
  const masterKeyEncoded = b64uEncode(masterKey);
  const labels = [HKDF_LABELS.contentKey, HKDF_LABELS.authKey, HKDF_LABELS.checkKey] as const;
  const hkdf: HkdfVector[] = [];
  for (const label of labels) {
    hkdf.push({
      name: label.slice("pneumo/v1/".length),
      masterKey: masterKeyEncoded,
      label,
      length: 32,
      output: b64uEncode(await deriveHkdf(masterKey, label)),
    });
  }

  const derived = await deriveKeys(masterKey);
  const authKey = b64uEncode(derived.authKey);
  const checked = b64uEncode(await keyCheck(masterKey));
  const fileKey = deterministicBytes(32, 29, 5);
  const nonce = deterministicBytes(12, 17, 9);
  const fileKeyEncoded = b64uEncode(fileKey);
  const payloads: Array<{ name: string; payload: PushPayload }> = [
    {
      name: "note",
      payload: {
        type: "note",
        title: "Vector note",
        body: "Deterministic note body \u2014 \u2603",
      },
    },
    {
      name: "link",
      payload: {
        type: "link",
        title: "Vector link",
        body: "A fixed link payload",
        url: "https://example.test/path?q=vector#fragment",
      },
    },
    {
      name: "file",
      payload: {
        type: "file",
        title: "Vector file",
        body: "A fixed file payload",
        file: {
          name: "vector.bin",
          mime: "application/octet-stream",
          size: 200_000,
          key: fileKeyEncoded,
        },
      },
    },
  ];
  const envelope: EnvelopeVector[] = [];
  for (const { name, payload } of payloads) {
    envelope.push({
      name,
      masterKey: masterKeyEncoded,
      pushId: PUSH_ID,
      nonce: b64uEncode(nonce),
      payload,
      envelope: await encryptPushWithNonce(derived.contentKey, PUSH_ID, payload, nonce),
    });
  }

  const fileCases: FileVector[] = [];
  for (const size of FILE_SIZES) {
    const plaintext = vectorPlaintext(size);
    const ciphertext = new Uint8Array(
      await (await encryptBlob(fileKey, FILE_ID, new Blob([plaintext]))).arrayBuffer(),
    );
    const vector: FileVector = {
      name: `size-${size}`,
      size,
      ciphertextLength: ciphertext.byteLength,
    };
    if (size <= FULL_CIPHERTEXT_MAX_SIZE) {
      vector.ciphertext = b64uEncode(ciphertext);
    } else {
      vector.sha256 = b64uEncode(
        new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", ciphertext)),
      );
    }
    fileCases.push(vector);
  }

  return {
    $comment: [
      "All binary strings in this document, including SHA-256 digests, use unpadded RFC 4648 base64url.",
      "Shape: kdf[] = {name, passphrase, params:{alg,iterations,salt}, masterKey}; passphrases are fixed fake test inputs and implementations normalize them to NFC before UTF-8 encoding.",
      "Shape: hkdf[] = {name, masterKey, label, length, output}; keyCheck[] and authKey[] = {name, masterKey, output}. masterKey and output are 32-byte values.",
      "Shape: envelope[] = {name, masterKey, pushId, nonce, payload, envelope:{v,n,c}}. nonce/envelope.n are 12 bytes and envelope.c is AES-GCM ciphertext with its 16-byte tag appended.",
      "Shape: file = {key,fileId,plaintextPattern,cases:[{name,size,ciphertextLength,ciphertext?|sha256?}]}. key is 32 bytes; ciphertext includes the 8-byte PNMF header. Cases through 65537 contain full ciphertext; size 200000 contains only its ciphertext SHA-256.",
      "File plaintext byte i is (i * 31 + 17) & 255. This applies independently to every file case, including the zero-length case.",
      "Shape: negative[] = {name,operation,source,mutation,expected}. source names an envelope case or file size; mutation is applied to that source exactly as described. Byte indices are zero-based, truncate length is the retained prefix length, append.bytes is base64url, xor values affect one byte, and replacements change AAD input without changing ciphertext.",
      "Negative operation decryptPush uses source:{section:'envelope',name} and mutation:{type:'xor-last-byte',field:'envelope.c',xor} or {type:'replace-push-id',value}.",
      "Negative operation decryptFile uses source:{section:'file',size} and mutation:{type:'xor-last-byte',field:'ciphertext',xor}, {type:'truncate',length}, {type:'append',bytes}, {type:'replace-file-id',value}, or {type:'xor-byte',field:'ciphertext',index,xor}. All negative cases have expected:'reject'.",
    ],
    version: 1,
    kdf: [
      productionKdf.vector,
      fastAsciiKdf.vector,
      fastNfcComposedKdf.vector,
      fastNfcDecomposedKdf.vector,
    ],
    hkdf,
    keyCheck: [{ name: "check", masterKey: masterKeyEncoded, output: checked }],
    authKey: [{ name: "auth", masterKey: masterKeyEncoded, output: authKey }],
    envelope,
    file: {
      key: fileKeyEncoded,
      fileId: FILE_ID,
      plaintextPattern: "byte[i] = (i * 31 + 17) & 255",
      cases: fileCases,
    },
    negative: [
      {
        name: "envelope-tampered-tag",
        operation: "decryptPush",
        source: { section: "envelope", name: "note" },
        mutation: { type: "xor-last-byte", field: "envelope.c", xor: 1 },
        expected: "reject",
      },
      {
        name: "envelope-wrong-aad",
        operation: "decryptPush",
        source: { section: "envelope", name: "link" },
        mutation: { type: "replace-push-id", value: WRONG_PUSH_ID },
        expected: "reject",
      },
      {
        name: "file-tampered-tag",
        operation: "decryptFile",
        source: { section: "file", size: 1 },
        mutation: { type: "xor-last-byte", field: "ciphertext", xor: 1 },
        expected: "reject",
      },
      {
        name: "file-truncated-at-chunk-boundary",
        operation: "decryptFile",
        source: { section: "file", size: 65_537 },
        mutation: { type: "truncate", length: FIRST_ENCRYPTED_CHUNK_BOUNDARY },
        expected: "reject",
      },
      {
        name: "file-trailing-byte",
        operation: "decryptFile",
        source: { section: "file", size: 1 },
        mutation: { type: "append", bytes: "AA" },
        expected: "reject",
      },
      {
        name: "file-wrong-aad",
        operation: "decryptFile",
        source: { section: "file", size: 65_535 },
        mutation: { type: "replace-file-id", value: WRONG_FILE_ID },
        expected: "reject",
      },
      {
        name: "file-wrong-header",
        operation: "decryptFile",
        source: { section: "file", size: 0 },
        mutation: { type: "xor-byte", field: "ciphertext", index: 0, xor: 1 },
        expected: "reject",
      },
    ],
  };
}

export async function serializeVectors(vectors?: CryptoVectors): Promise<string> {
  return `${JSON.stringify(vectors ?? (await buildVectors()), null, 2)}\n`;
}
