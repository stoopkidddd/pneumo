import {
  b64uDecode,
  b64uEncode,
  createFileDecryptor,
  createFileEncryptor,
  generateFileKey,
} from "@pneumo/crypto";
import { ciphertextSize, type FilePayload, type UploadMode } from "@pneumo/protocol";
import type { ApiClient } from "../api/client.js";
import { envelopeByteLength } from "../home/payload.js";
import * as sessionStore from "../session/store.js";

export type TransferProgress = {
  phase: "encrypting" | "uploading" | "downloading" | "decrypting";
  loaded: number;
  total: number;
};

const TAMPER_ERROR = "This file was corrupted or tampered with";
const units = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

class DownloadNetworkError extends Error {}
class DownloadIntegrityError extends Error {}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.floor(bytes)} B`;

  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unitIndex;
  const rounded = value >= 10 ? value.toFixed(0) : value.toFixed(1);
  return `${rounded.replace(/\.0$/, "")} ${units[unitIndex]}`;
}

function buildFilePayload(file: File, key: string, body?: string, title?: string): FilePayload {
  return {
    type: "file",
    ...(title === undefined ? {} : { title }),
    ...(body === undefined ? {} : { body }),
    file: {
      name: file.name,
      mime: file.type || "application/octet-stream",
      size: file.size,
      key,
    },
  };
}

export function validateFile(options: {
  file: File;
  body?: string;
  title?: string;
  maxFileBytes: number;
  maxEnvelopeBytes: number;
}): void {
  const { file, body, title, maxFileBytes, maxEnvelopeBytes } = options;
  const encryptedSize = ciphertextSize(file.size);
  if (encryptedSize > maxFileBytes) {
    throw new Error(`The encrypted file exceeds the ${formatBytes(maxFileBytes)} file limit`);
  }

  const payload = buildFilePayload(file, "A".repeat(43), body, title);
  if (envelopeByteLength(payload) > maxEnvelopeBytes) {
    throw new Error(
      `The encrypted file details exceed the ${formatBytes(maxEnvelopeBytes)} message limit`,
    );
  }
}

function progressTransform(
  phase: TransferProgress["phase"],
  total: number,
  onProgress: (progress: TransferProgress) => void,
  onLoaded?: (loaded: number) => void,
): TransformStream<Uint8Array, Uint8Array> {
  let loaded = 0;
  onProgress({ phase, loaded, total });
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      loaded += chunk.byteLength;
      onLoaded?.(loaded);
      onProgress({ phase, loaded: Math.min(loaded, total), total });
      controller.enqueue(chunk);
    },
  });
}

async function streamBlob(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  type = "",
): Promise<Blob> {
  throwIfAborted(signal);
  const reader = stream.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const onAbort = () => {
    void reader.cancel(abortError()).catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      throwIfAborted(signal);
      const result = await reader.read();
      throwIfAborted(signal);
      if (result.done) break;
      chunks.push(result.value.slice());
    }
    return new Blob(chunks, type ? { type } : undefined);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function transferHeaders(
  descriptor: { url: string; headers: Record<string, string> },
  uploadMode: UploadMode,
  token: string,
): { headers: Headers; proxy: boolean } {
  const headers = new Headers(descriptor.headers);
  const proxy =
    uploadMode === "proxy" ||
    (uploadMode === "auto" && descriptor.url.startsWith("/") && !descriptor.url.startsWith("//"));
  if (proxy) {
    if (!descriptor.url.startsWith("/") || descriptor.url.startsWith("//")) {
      throw new Error("Invalid file transfer destination");
    }
    headers.set("Authorization", `Bearer ${token}`);
  }
  return { headers, proxy };
}

async function handleProxyUnauthorized(onUnauthorized: () => void | Promise<void>): Promise<void> {
  try {
    await sessionStore.clear();
  } catch {
    // Continue to signed-out UI even if local storage cleanup failed.
  }
  try {
    await onUnauthorized();
  } catch {
    // The transfer still rejects with its HTTP status below.
  }
}

function uploadBlob(
  descriptor: { method: "PUT"; url: string; headers: Record<string, string> },
  blob: Blob,
  token: string,
  uploadMode: UploadMode,
  signal: AbortSignal,
  onProgress: (progress: TransferProgress) => void,
  onUnauthorized: () => void | Promise<void>,
): Promise<void> {
  throwIfAborted(signal);
  const { headers, proxy } = transferHeaders(descriptor, uploadMode, token);
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const request = new XMLHttpRequest();
  let settled = false;

  const cleanup = () => {
    signal.removeEventListener("abort", onAbort);
    request.onload = null;
    request.onerror = null;
    request.onabort = null;
    request.upload.onprogress = null;
  };
  const succeed = () => {
    if (settled) return;
    settled = true;
    cleanup();
    resolve();
  };
  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    cleanup();
    reject(error);
  };
  const onAbort = () => {
    request.abort();
    fail(abortError());
  };

  try {
    request.open(descriptor.method, descriptor.url);
    for (const [name, value] of headers) {
      if (name.toLowerCase() !== "content-length") request.setRequestHeader(name, value);
    }
    request.upload.onprogress = (event) => {
      onProgress({
        phase: "uploading",
        loaded: Math.min(event.loaded, blob.size),
        total: blob.size,
      });
    };
    request.onerror = () => fail(new Error("File upload failed due to a network error"));
    request.onabort = () => fail(abortError());
    request.onload = () => {
      void (async () => {
        if (request.status >= 200 && request.status < 300) {
          succeed();
          return;
        }
        if (proxy && request.status === 401) await handleProxyUnauthorized(onUnauthorized);
        fail(new Error(`File upload failed (HTTP ${request.status})`));
      })();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    throwIfAborted(signal);
    onProgress({ phase: "uploading", loaded: 0, total: blob.size });
    request.send(blob);
  } catch (error) {
    fail(error);
  }
  return promise;
}

export async function uploadFile(options: {
  api: ApiClient;
  token: string;
  uploadMode: UploadMode;
  file: File;
  body?: string;
  title?: string;
  maxFileBytes: number;
  maxEnvelopeBytes: number;
  signal: AbortSignal;
  onProgress: (progress: TransferProgress) => void;
  onUnauthorized: () => void | Promise<void>;
}): Promise<{ payload: FilePayload; file: { id: string; size: number } }> {
  const {
    api,
    token,
    uploadMode,
    file,
    body,
    title,
    maxFileBytes,
    maxEnvelopeBytes,
    signal,
    onProgress,
    onUnauthorized,
  } = options;
  throwIfAborted(signal);

  validateFile({
    file,
    ...(body === undefined ? {} : { body }),
    ...(title === undefined ? {} : { title }),
    maxFileBytes,
    maxEnvelopeBytes,
  });
  const encryptedSize = ciphertextSize(file.size);
  const fileKey = generateFileKey();
  const payload = buildFilePayload(file, b64uEncode(fileKey), body, title);

  throwIfAborted(signal);
  const reservation = await api.request("createFile", {
    body: { size: encryptedSize },
    signal,
  });
  throwIfAborted(signal);

  const encrypted = file
    .stream()
    .pipeThrough(progressTransform("encrypting", file.size, onProgress))
    .pipeThrough(createFileEncryptor(fileKey, reservation.fileId));
  const blob = await streamBlob(encrypted, signal);
  if (blob.size !== encryptedSize) throw new Error("File encryption produced an invalid size");

  throwIfAborted(signal);
  await uploadBlob(reservation.upload, blob, token, uploadMode, signal, onProgress, onUnauthorized);
  return { payload, file: { id: reservation.fileId, size: encryptedSize } };
}

function trackedDownloadStream(
  body: ReadableStream<Uint8Array>,
  expectedSize: number,
  signal: AbortSignal,
  onProgress: (progress: TransferProgress) => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let loaded = 0;
  onProgress({ phase: "downloading", loaded, total: expectedSize });

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          if (loaded !== expectedSize) controller.error(new DownloadIntegrityError());
          else controller.close();
          return;
        }
        loaded += result.value.byteLength;
        onProgress({
          phase: "downloading",
          loaded: Math.min(loaded, expectedSize),
          total: expectedSize,
        });
        controller.enqueue(result.value);
      } catch (error) {
        if (signal.aborted || isAbortError(error)) controller.error(abortError());
        else
          controller.error(new DownloadNetworkError("File download failed due to a network error"));
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const revokeObjectURL = URL.revokeObjectURL.bind(URL);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.hidden = true;
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => revokeObjectURL(url), 0);
  }
}

export async function downloadFile(options: {
  api: ApiClient;
  token: string;
  uploadMode: UploadMode;
  fileId: string;
  payload: FilePayload;
  signal: AbortSignal;
  onProgress: (progress: TransferProgress) => void;
  onUnauthorized: () => void | Promise<void>;
}): Promise<void> {
  const { api, token, uploadMode, fileId, payload, signal, onProgress, onUnauthorized } = options;
  throwIfAborted(signal);
  const descriptor = await api.request("getFile", { params: { id: fileId }, signal });
  throwIfAborted(signal);

  const { headers, proxy } = transferHeaders(descriptor.download, uploadMode, token);
  let response: Response;
  try {
    response = await fetch(descriptor.download.url, { method: "GET", headers, signal });
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw abortError();
    throw new Error("File download failed due to a network error");
  }

  if (!response.ok) {
    await response.body?.cancel();
    if (proxy && response.status === 401) await handleProxyUnauthorized(onUnauthorized);
    throw new Error(`File download failed (HTTP ${response.status})`);
  }
  if (response.body === null) throw new Error("File download failed due to a network error");

  const expectedCiphertextSize = ciphertextSize(payload.file.size);
  let plaintextLoaded = 0;
  const ciphertext = trackedDownloadStream(
    response.body,
    expectedCiphertextSize,
    signal,
    onProgress,
  );
  const plaintext = ciphertext
    .pipeThrough(createFileDecryptor(b64uDecode(payload.file.key), fileId))
    .pipeThrough(
      progressTransform("decrypting", payload.file.size, onProgress, (loaded) => {
        plaintextLoaded = loaded;
      }),
    );

  let blob: Blob;
  try {
    blob = await streamBlob(plaintext, signal, payload.file.mime);
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw abortError();
    if (error instanceof DownloadNetworkError) throw error;
    throw new Error(TAMPER_ERROR);
  }
  if (plaintextLoaded !== payload.file.size) throw new Error(TAMPER_ERROR);
  throwIfAborted(signal);
  saveBlob(blob, payload.file.name);
}
