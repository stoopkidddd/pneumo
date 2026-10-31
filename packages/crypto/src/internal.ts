import { type Envelope, PUSH_AAD_PREFIX, PushPayload } from "@pneumo/protocol";
import { b64uEncode } from "./encoding.js";

export const utf8 = new TextEncoder();

export function requireKeyBytes(bytes: Uint8Array): void {
  if (bytes.byteLength !== 32) throw new TypeError("Expected a 32-byte key");
}

// This module is not a package export. Fixed nonces are only used by vector generation.
export async function deriveHkdf(mk: Uint8Array, label: string): Promise<Uint8Array<ArrayBuffer>> {
  requireKeyBytes(mk);
  const key = await globalThis.crypto.subtle.importKey("raw", mk.slice(), "HKDF", false, [
    "deriveBits",
  ]);
  return new Uint8Array(
    await globalThis.crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: utf8.encode(label) },
      key,
      256,
    ),
  );
}

export async function encryptPushWithNonce(
  contentKey: CryptoKey,
  pushId: string,
  payload: PushPayload,
  nonce: Uint8Array<ArrayBuffer>,
): Promise<Envelope> {
  if (nonce.byteLength !== 12) throw new TypeError("Expected a 12-byte nonce");
  PushPayload.parse(payload);
  const plaintext = utf8.encode(JSON.stringify(payload));
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: utf8.encode(PUSH_AAD_PREFIX + pushId) },
    contentKey,
    plaintext,
  );
  return { v: 1, n: b64uEncode(nonce), c: b64uEncode(new Uint8Array(ciphertext)) };
}
