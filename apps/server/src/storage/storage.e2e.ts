import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { Writable } from "node:stream";
import { expect, inject, test } from "vitest";
import { createLogger } from "../log.js";
import { S3Storage } from "./s3.js";
import { type PresignedUseOptions, storageContract } from "./storage.contract.js";
import { type PresignedRequest, StorageError } from "./types.js";
import { resolveUploadMode } from "./upload-mode.js";

declare module "vitest" {
  export interface ProvidedContext {
    minio: Record<string, string>;
  }
}

const minio = inject("minio");

function required(name: string): string {
  const value = minio[name];
  if (!value) throw new Error(`MinIO setup did not provide ${name}`);
  return value;
}

const baseConfig = {
  S3_ENDPOINT: required("S3_ENDPOINT"),
  S3_REGION: required("S3_REGION"),
  S3_BUCKET: required("S3_BUCKET"),
  S3_ACCESS_KEY_ID: required("S3_ACCESS_KEY_ID"),
  S3_SECRET_ACCESS_KEY: required("S3_SECRET_ACCESS_KEY"),
  S3_FORCE_PATH_STYLE: required("S3_FORCE_PATH_STYLE") === "true",
};

function sendPresignedRequest(
  request: PresignedRequest,
  options: PresignedUseOptions,
): Promise<Response> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new Error("Invalid presigned request");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Invalid presigned request protocol");
  }
  const headers = new Headers(request.headers);
  for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
  const transport = url.protocol === "https:" ? requestHttps : requestHttp;

  const { promise, resolve, reject } = Promise.withResolvers<Response>();
  const outgoing = transport(
    url,
    {
      method: options.method,
      headers: Object.fromEntries(headers),
      timeout: 10_000,
    },
    (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.once("error", () => reject(new Error("Presigned response failed")));
      incoming.once("end", () => {
        const status = incoming.statusCode ?? 500;
        const body = Buffer.concat(chunks);
        const hasResponseBody = status >= 200 && status < 300 && status !== 204 && status !== 205;
        resolve(new Response(hasResponseBody ? body : null, { status }));
      });
    },
  );
  outgoing.once("timeout", () => {
    outgoing.destroy();
    reject(new Error("Presigned request timed out"));
  });
  outgoing.once("error", () => reject(new Error("Presigned request failed")));
  outgoing.end(options.body);
  return promise;
}

storageContract(
  "S3Storage",
  (prefix) => {
    const storage = new S3Storage({ ...baseConfig, S3_PREFIX: prefix });
    return { storage, close: () => storage.destroy() };
  },
  (_storage, request, options) => sendPresignedRequest(request, options),
);

test("auto upload mode reflects MinIO bucket CORS capability with a safe reason", async () => {
  const lines: string[] = [];
  const logger = createLogger(
    "info",
    new Writable({
      write(chunk, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    }),
  );
  const storage = new S3Storage({
    ...baseConfig,
    S3_PREFIX: `upload-mode/${randomUUID()}`,
  });

  try {
    let expectedMode: "direct" | "proxy" = "direct";
    let expectedOperation: "applyCors" | "getCors" | undefined;
    let expectedReason: string | undefined;
    let expectedBucketMissing = false;
    try {
      await storage.applyCors(["https://pneumo.example"]);
      expectedOperation = "getCors";
      await storage.getCors();
      expectedOperation = undefined;
    } catch (error) {
      expectedMode = "proxy";
      expectedOperation ??= "applyCors";
      expectedReason = error instanceof StorageError ? error.code : "Other";
      expectedBucketMissing = error instanceof StorageError && error.bucketMissing;
    }

    const mode = await resolveUploadMode({
      storage,
      mode: "auto",
      publicUrl: "https://pneumo.example",
      logger,
    });
    expect(mode).toBe(expectedMode);
    const rows = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows).toHaveLength(1);
    const observed = rows[0] ?? {};
    console.info(
      JSON.stringify({
        uploadMode: observed.uploadMode,
        ...(observed.operation === undefined ? {} : { operation: observed.operation }),
        ...(observed.reason === undefined ? {} : { reason: observed.reason }),
        ...(observed.bucketMissing === undefined ? {} : { bucketMissing: observed.bucketMissing }),
      }),
    );
    if (expectedMode === "direct") {
      expect(observed).toMatchObject({
        level: 30,
        uploadMode: "direct",
      });
      expect(observed).not.toHaveProperty("reason");
    } else {
      expect(observed).toMatchObject({
        level: 40,
        uploadMode: "proxy",
        operation: expectedOperation,
        reason: expectedReason,
        bucketMissing: expectedBucketMissing,
      });
    }
  } finally {
    storage.destroy();
  }
});
