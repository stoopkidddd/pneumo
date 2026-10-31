import { detectLink, type PushPayload } from "@pneumo/protocol";

const utf8 = new TextEncoder();
const GCM_TAG_BYTES = 16;
const ENVELOPE_FIXED_BYTES = utf8.encode(
  JSON.stringify({ v: 1, n: "A".repeat(16), c: "" }),
).byteLength;

export function buildPushPayload(message: string, title: string): PushPayload {
  const optionalTitle = title.trim().length > 0 ? { title } : {};
  if (detectLink(message)) {
    return { type: "link", url: message.trim(), ...optionalTitle };
  }
  return { type: "note", body: message, ...optionalTitle };
}

export function envelopeByteLength(payload: PushPayload): number {
  const plaintextBytes = utf8.encode(JSON.stringify(payload)).byteLength;
  const ciphertextBytes = plaintextBytes + GCM_TAG_BYTES;
  const ciphertextCharacters = Math.ceil((ciphertextBytes * 4) / 3);
  return ENVELOPE_FIXED_BYTES + ciphertextCharacters;
}
