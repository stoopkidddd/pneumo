import {
  DEFAULT_KDF_ITERATIONS,
  Envelope,
  HKDF_LABELS,
  KdfParams,
  KEY_CHECK_LABEL,
  PUSH_AAD_PREFIX,
  PushPayload,
} from "@pneumo/protocol";
import { b64uDecode, b64uEncode } from "./encoding.js";
import { deriveHkdf, encryptPushWithNonce, utf8 } from "./internal.js";

export { b64uDecode, b64uEncode } from "./encoding.js";
export {
  createFileDecryptor,
  createFileEncryptor,
  decryptBlob,
  encryptBlob,
  generateFileKey,
} from "./files.js";
export { buildPairingUri, type PairingData, parsePairingUri } from "./pairing.js";

export function newKdfParams(): KdfParams {
  return {
    alg: "PBKDF2-SHA256",
    salt: b64uEncode(globalThis.crypto.getRandomValues(new Uint8Array(16))),
    iterations: DEFAULT_KDF_ITERATIONS,
  };
}

export async function deriveMasterKey(
  passphrase: string,
  kdf: KdfParams,
): Promise<Uint8Array<ArrayBuffer>> {
  const params = KdfParams.parse(kdf);
  const password = await globalThis.crypto.subtle.importKey(
    "raw",
    utf8.encode(passphrase.normalize("NFC")),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return new Uint8Array(
    await globalThis.crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: b64uDecode(params.salt),
        iterations: params.iterations,
      },
      password,
      256,
    ),
  );
}

export type DerivedKeys = { contentKey: CryptoKey; authKey: Uint8Array<ArrayBuffer> };

export async function deriveKeys(mk: Uint8Array): Promise<DerivedKeys> {
  const [contentBytes, authKey] = await Promise.all([
    deriveHkdf(mk, HKDF_LABELS.contentKey),
    deriveHkdf(mk, HKDF_LABELS.authKey),
  ]);
  const contentKey = await globalThis.crypto.subtle.importKey(
    "raw",
    contentBytes,
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
  return { contentKey, authKey };
}

export async function keyCheck(mk: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = await deriveHkdf(mk, HKDF_LABELS.checkKey);
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await globalThis.crypto.subtle.sign("HMAC", key, utf8.encode(KEY_CHECK_LABEL)),
  );
}

export async function encryptPush(
  contentKey: CryptoKey,
  pushId: string,
  payload: PushPayload,
): Promise<Envelope> {
  return encryptPushWithNonce(
    contentKey,
    pushId,
    payload,
    globalThis.crypto.getRandomValues(new Uint8Array(12)),
  );
}

export async function decryptPush(
  contentKey: CryptoKey,
  pushId: string,
  envelope: Envelope,
): Promise<PushPayload> {
  const parsed = Envelope.parse(envelope);
  const plaintext = await globalThis.crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: b64uDecode(parsed.n),
      additionalData: utf8.encode(PUSH_AAD_PREFIX + pushId),
    },
    contentKey,
    b64uDecode(parsed.c),
  );
  return PushPayload.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)));
}
