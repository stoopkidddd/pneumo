import { B64u } from "@pneumo/protocol";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function b64uEncode(bytes: Uint8Array): string {
  let encoded = "";
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const first = bytes[offset] ?? 0;
    const second = bytes[offset + 1] ?? 0;
    const third = bytes[offset + 2] ?? 0;
    encoded += alphabet[first >>> 2];
    encoded += alphabet[((first & 3) << 4) | (second >>> 4)];
    if (offset + 1 < bytes.length) encoded += alphabet[((second & 15) << 2) | (third >>> 6)];
    if (offset + 2 < bytes.length) encoded += alphabet[third & 63];
  }
  return encoded;
}

export function b64uDecode(value: string): Uint8Array<ArrayBuffer> {
  B64u.parse(value);
  const bytes = new Uint8Array(Math.floor((value.length * 3) / 4));
  let bits = 0;
  let bitCount = 0;
  let offset = 0;
  for (const character of value) {
    bits = (bits << 6) | alphabet.indexOf(character);
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes[offset++] = (bits >>> bitCount) & 255;
    }
  }
  return bytes;
}
