// @vitest-environment jsdom
import { Blob as NodeBlob } from "node:buffer";
import { webcrypto } from "node:crypto";
import { b64uDecode, b64uEncode, createFileDecryptor, createFileEncryptor } from "@pneumo/crypto";
import { ciphertextSize, type FilePayload } from "@pneumo/protocol";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ApiClient } from "../api/client.js";
import { envelopeByteLength } from "../home/payload.js";
import { downloadFile, uploadFile, validateFile } from "./transfer.js";

const sessionStore = vi.hoisted(() => ({ clear: vi.fn() }));
vi.mock("../session/store.js", () => sessionStore);

const fileId = "019a3598-c400-7000-8000-000000000010";

class FakeXMLHttpRequest {
  static instances: FakeXMLHttpRequest[] = [];
  static autoComplete = true;

  readonly upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
  readonly headers = new Headers();
  status = 0;
  body: Blob | null = null;
  aborted = false;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeXMLHttpRequest.instances.push(this);
  }

  open(): void {}

  setRequestHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }

  send(body: Blob): void {
    this.body = body;
    if (!FakeXMLHttpRequest.autoComplete) return;
    queueMicrotask(() => {
      this.upload.onprogress?.(
        new ProgressEvent("progress", {
          lengthComputable: true,
          loaded: body.size,
          total: body.size,
        }),
      );
      this.status = 200;
      this.onload?.();
    });
  }

  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }
}

function fileFromBytes(bytes: Uint8Array, name = "payload.bin"): File {
  const contents = bytes.slice();
  return {
    name,
    type: "application/octet-stream",
    size: contents.byteLength,
    stream() {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(contents);
          controller.close();
        },
      });
    },
  } as File;
}

function createUploadApi(): ApiClient {
  return {
    request: vi.fn(async (name: string) => {
      if (name !== "createFile") throw new Error("Unexpected API request");
      return {
        fileId,
        upload: {
          method: "PUT" as const,
          url: "https://storage.example.test/upload",
          headers: { "Content-Length": "signed length", "X-Signed-Header": "required" },
        },
        expiresAt: "2026-10-31T12:00:00.000Z",
      };
    }) as ApiClient["request"],
  };
}

async function transformBytes(
  bytes: Uint8Array,
  transform: TransformStream<Uint8Array, Uint8Array>,
): Promise<Uint8Array<ArrayBuffer>> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Uint8Array(await new Response(source.pipeThrough(transform)).arrayBuffer());
}

beforeEach(() => {
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
  FakeXMLHttpRequest.instances = [];
  FakeXMLHttpRequest.autoComplete = true;
  sessionStore.clear.mockReset();
  sessionStore.clear.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("validateFile", () => {
  test("accepts the exact ciphertext limit and rejects one byte below it", () => {
    const file = fileFromBytes(new Uint8Array(65_536));
    const exactLimit = ciphertextSize(file.size);

    expect(() =>
      validateFile({ file, maxFileBytes: exactLimit, maxEnvelopeBytes: 65_536 }),
    ).not.toThrow();
    expect(() =>
      validateFile({ file, maxFileBytes: exactLimit - 1, maxEnvelopeBytes: 65_536 }),
    ).toThrow("64 KiB file limit");
  });

  test("uses the encrypted envelope's exact serialized boundary", () => {
    const file = fileFromBytes(new Uint8Array(1), "résumé.pdf");
    const payload: FilePayload = {
      type: "file",
      title: "Quarterly ☃",
      body: 'See the attached "report"',
      file: {
        name: file.name,
        mime: file.type,
        size: file.size,
        key: "A".repeat(43),
      },
    };
    const exactLimit = envelopeByteLength(payload);

    expect(() =>
      validateFile({
        file,
        title: "Quarterly ☃",
        body: 'See the attached "report"',
        maxFileBytes: ciphertextSize(file.size),
        maxEnvelopeBytes: exactLimit,
      }),
    ).not.toThrow();
    expect(() =>
      validateFile({
        file,
        title: "Quarterly ☃",
        body: 'See the attached "report"',
        maxFileBytes: ciphertextSize(file.size),
        maxEnvelopeBytes: exactLimit - 1,
      }),
    ).toThrow(/message limit/);
  });
});

test("uploads real authenticated ciphertext and omits forbidden and bearer headers in direct mode", async () => {
  const bytes = new Uint8Array([2, 3, 5, 7, 11, 13]);
  const progress = vi.fn();
  const result = await uploadFile({
    api: createUploadApi(),
    token: "test-device-credential",
    uploadMode: "direct",
    file: fileFromBytes(bytes),
    title: "  Attached title  ",
    body: "Attached",
    maxFileBytes: 1_000,
    maxEnvelopeBytes: 1_000,
    signal: new AbortController().signal,
    onProgress: progress,
    onUnauthorized: vi.fn(),
  });

  const request = FakeXMLHttpRequest.instances[0];
  expect(request?.headers.has("Authorization")).toBe(false);
  expect(request?.headers.has("Content-Length")).toBe(false);
  expect(request?.headers.has("X-Signed-Header")).toBe(true);
  const uploaded = request?.body;
  expect(uploaded?.size).toBe(ciphertextSize(bytes.byteLength));
  if (!uploaded) throw new Error("Expected an encrypted upload body");
  const ciphertext = new Uint8Array(await uploaded.arrayBuffer());
  const plaintext = await transformBytes(
    ciphertext,
    createFileDecryptor(b64uDecode(result.payload.file.key), fileId),
  );
  expect(plaintext).toEqual(bytes);
  expect(result.file).toEqual({ id: fileId, size: ciphertextSize(bytes.byteLength) });
  expect(result.payload.title).toBe("  Attached title  ");
  expect(result.payload.body).toBe("Attached");
  expect(progress).toHaveBeenCalledWith({
    phase: "uploading",
    loaded: ciphertextSize(bytes.byteLength),
    total: ciphertextSize(bytes.byteLength),
  });
});

test.each([
  { title: "", body: "" },
  { title: " \t ", body: " \n " },
])("omits blank optional metadata at the exact envelope limit: %j", async (metadata) => {
  const file = fileFromBytes(new Uint8Array([42]));
  const maxEnvelopeBytes = envelopeByteLength({
    type: "file",
    file: {
      name: file.name,
      mime: file.type,
      size: file.size,
      key: "A".repeat(43),
    },
  });
  const result = await uploadFile({
    api: createUploadApi(),
    token: "test-device-credential",
    uploadMode: "direct",
    file,
    ...metadata,
    maxFileBytes: ciphertextSize(file.size),
    maxEnvelopeBytes,
    signal: new AbortController().signal,
    onProgress: vi.fn(),
    onUnauthorized: vi.fn(),
  });

  expect(Object.hasOwn(result.payload, "title")).toBe(false);
  expect(Object.hasOwn(result.payload, "body")).toBe(false);
  expect(envelopeByteLength(result.payload)).toBe(maxEnvelopeBytes);
});

test("a pre-cancelled upload rejects before reservation, encryption, or binary network", async () => {
  const api = createUploadApi();
  const onProgress = vi.fn();
  const controller = new AbortController();
  controller.abort();

  await expect(
    uploadFile({
      api,
      token: "test-device-credential",
      uploadMode: "proxy",
      file: fileFromBytes(new Uint8Array([1])),
      maxFileBytes: 100,
      maxEnvelopeBytes: 1_000,
      signal: controller.signal,
      onProgress,
      onUnauthorized: vi.fn(),
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(api.request).not.toHaveBeenCalled();
  expect(FakeXMLHttpRequest.instances).toHaveLength(0);
  expect(onProgress).not.toHaveBeenCalled();
});

test("aborting an active upload cancels XHR, detaches its signal, and cannot later complete", async () => {
  FakeXMLHttpRequest.autoComplete = false;
  const controller = new AbortController();
  const removeListener = vi.spyOn(controller.signal, "removeEventListener");
  const transfer = uploadFile({
    api: createUploadApi(),
    token: "test-device-credential",
    uploadMode: "direct",
    file: fileFromBytes(new Uint8Array([1, 2, 3])),
    maxFileBytes: 100,
    maxEnvelopeBytes: 1_000,
    signal: controller.signal,
    onProgress: vi.fn(),
    onUnauthorized: vi.fn(),
  });
  await vi.waitFor(() => expect(FakeXMLHttpRequest.instances).toHaveLength(1));

  controller.abort();
  await expect(transfer).rejects.toMatchObject({ name: "AbortError" });
  const request = FakeXMLHttpRequest.instances[0];
  expect(request?.aborted).toBe(true);
  expect(request?.onload).toBeNull();
  expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
});

test("downloads and authenticates the complete stream before saving", async () => {
  const bytes = new TextEncoder().encode("authenticated download");
  const key = crypto.getRandomValues(new Uint8Array(32));
  const ciphertext = await transformBytes(bytes, createFileEncryptor(key, fileId));
  const payload: FilePayload = {
    type: "file",
    file: {
      name: "download.txt",
      mime: "text/plain",
      size: bytes.byteLength,
      key: b64uEncode(key),
    },
  };
  const api = {
    request: vi.fn(async () => ({
      download: { url: "https://storage.example.test/download", headers: {} },
      expiresAt: "2026-10-31T12:00:00.000Z",
    })) as ApiClient["request"],
  };
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(ciphertext));
  vi.stubGlobal("fetch", fetchMock);
  const createObjectURL = vi.fn((_blob: Blob) => "blob:download");
  const revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

  await downloadFile({
    api,
    token: "test-device-credential",
    uploadMode: "direct",
    fileId,
    payload,
    signal: new AbortController().signal,
    onProgress: vi.fn(),
    onUnauthorized: vi.fn(),
  });

  expect(click).toHaveBeenCalledOnce();
  expect((click.mock.instances[0] as HTMLAnchorElement).download).toBe("download.txt");
  const saved = createObjectURL.mock.calls[0]?.[0] as Blob;
  expect(Array.from(new Uint8Array(await saved.arrayBuffer()))).toEqual(Array.from(bytes));
  const sentHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
  expect(sentHeaders.has("Authorization")).toBe(false);
});

test("a proxy binary 401 clears the session and notifies the caller", async () => {
  const payload: FilePayload = {
    type: "file",
    file: {
      name: "private.bin",
      mime: "application/octet-stream",
      size: 0,
      key: b64uEncode(new Uint8Array(32)),
    },
  };
  const api = {
    request: vi.fn(async () => ({
      download: { url: `/api/files/${fileId}/content`, headers: {} },
      expiresAt: "2026-10-31T12:00:00.000Z",
    })) as ApiClient["request"],
  };
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }));
  vi.stubGlobal("fetch", fetchMock);
  const onUnauthorized = vi.fn();

  await expect(
    downloadFile({
      api,
      token: "test-device-credential",
      uploadMode: "proxy",
      fileId,
      payload,
      signal: new AbortController().signal,
      onProgress: vi.fn(),
      onUnauthorized,
    }),
  ).rejects.toThrow("File download failed (HTTP 401)");
  expect(sessionStore.clear).toHaveBeenCalledOnce();
  expect(onUnauthorized).toHaveBeenCalledOnce();
  const sentHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
  expect(sentHeaders.has("Authorization")).toBe(true);
});

test("does not save ciphertext that fails authentication", async () => {
  const bytes = new Uint8Array(65_537).fill(7);
  const key = crypto.getRandomValues(new Uint8Array(32));
  const ciphertext = await transformBytes(bytes, createFileEncryptor(key, fileId));
  ciphertext[ciphertext.byteLength - 1] = (ciphertext[ciphertext.byteLength - 1] ?? 0) ^ 1;
  const payload: FilePayload = {
    type: "file",
    file: {
      name: "tampered.bin",
      mime: "application/octet-stream",
      size: bytes.byteLength,
      key: b64uEncode(key),
    },
  };
  const api = {
    request: vi.fn(async () => ({
      download: { url: "https://storage.example.test/download", headers: {} },
      expiresAt: "2026-10-31T12:00:00.000Z",
    })) as ApiClient["request"],
  };
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(ciphertext)));
  const createObjectURL = vi.fn((_blob: Blob) => "blob:unused");
  vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL: vi.fn() });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

  await expect(
    downloadFile({
      api,
      token: "test-device-credential",
      uploadMode: "direct",
      fileId,
      payload,
      signal: new AbortController().signal,
      onProgress: vi.fn(),
      onUnauthorized: vi.fn(),
    }),
  ).rejects.toThrow("This file was corrupted or tampered with");
  expect(createObjectURL).not.toHaveBeenCalled();
  expect(click).not.toHaveBeenCalled();
});
