import { FILE_AAD_PREFIX, FILE_CHUNK_SIZE, FILE_HEADER } from "@pneumo/protocol";
import { requireKeyBytes, utf8 } from "./internal.js";

const tagSize = 16;

function nonce(index: bigint, last: boolean): Uint8Array<ArrayBuffer> {
  if (index > 0xffff_ffff_ffff_ffffn) throw new RangeError("File chunk counter overflow");
  const bytes = new Uint8Array(12);
  new DataView(bytes.buffer).setBigUint64(3, index, false);
  bytes[11] = last ? 1 : 0;
  return bytes;
}

function fileTransform(
  fk: Uint8Array,
  fileId: string,
  decrypt: boolean,
): TransformStream<Uint8Array, Uint8Array> {
  requireKeyBytes(fk);
  const rawKey = fk.slice();
  const blockSize = FILE_CHUNK_SIZE + (decrypt ? tagSize : 0);
  const pending = new Uint8Array(blockSize);
  const aad = utf8.encode(FILE_AAD_PREFIX + fileId);
  let key: CryptoKey;
  let used = 0;
  let headerOffset = 0;
  let index = 0n;

  async function emit(controller: TransformStreamDefaultController<Uint8Array>, last: boolean) {
    if (decrypt && (used < tagSize || (used === tagSize && index > 0n))) {
      throw new Error("Invalid final file block");
    }
    const algorithm = { name: "AES-GCM", iv: nonce(index, last), additionalData: aad };
    const input = pending.subarray(0, used);
    const output = decrypt
      ? await globalThis.crypto.subtle.decrypt(algorithm, key, input)
      : await globalThis.crypto.subtle.encrypt(algorithm, key, input);
    controller.enqueue(new Uint8Array(output));
    index += 1n;
    used = 0;
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    async start(controller) {
      key = await globalThis.crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, [
        decrypt ? "decrypt" : "encrypt",
      ]);
      if (!decrypt) controller.enqueue(new Uint8Array(FILE_HEADER));
    },
    async transform(chunk, controller) {
      let offset = 0;
      if (decrypt) {
        while (headerOffset < FILE_HEADER.length && offset < chunk.length) {
          if (chunk[offset++] !== FILE_HEADER[headerOffset++]) {
            throw new Error("Invalid file header");
          }
        }
      }
      while (offset < chunk.length) {
        // Retain a full block until at least one following byte proves it is not last.
        if (used === blockSize) await emit(controller, false);
        const count = Math.min(blockSize - used, chunk.length - offset);
        pending.set(chunk.subarray(offset, offset + count), used);
        used += count;
        offset += count;
      }
    },
    async flush(controller) {
      if (decrypt && headerOffset !== FILE_HEADER.length) throw new Error("Missing file header");
      await emit(controller, true);
    },
  });
}

export function generateFileKey(): Uint8Array<ArrayBuffer> {
  return globalThis.crypto.getRandomValues(new Uint8Array(32));
}

export function createFileEncryptor(
  fk: Uint8Array,
  fileId: string,
): TransformStream<Uint8Array, Uint8Array> {
  return fileTransform(fk, fileId, false);
}

export function createFileDecryptor(
  fk: Uint8Array,
  fileId: string,
): TransformStream<Uint8Array, Uint8Array> {
  return fileTransform(fk, fileId, true);
}

export async function encryptBlob(fk: Uint8Array, fileId: string, blob: Blob): Promise<Blob> {
  return new Response(blob.stream().pipeThrough(createFileEncryptor(fk, fileId))).blob();
}

export async function decryptBlob(fk: Uint8Array, fileId: string, blob: Blob): Promise<Blob> {
  return new Response(blob.stream().pipeThrough(createFileDecryptor(fk, fileId))).blob();
}
