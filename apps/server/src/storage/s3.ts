import { isIP } from "node:net";
import { PassThrough, Readable } from "node:stream";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetBucketCorsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Config } from "../config.js";
import {
  type CorsRule,
  type PresignedRequest,
  type Storage,
  StorageError,
  type StorageObject,
  storagePrefix,
} from "./types.js";

const NETWORK_CONNECTION_TIMEOUT_MS = 2_000;
const CORS_REQUEST_TIMEOUT_MS = 2_000;
const DELETE_BATCH_SIZE = 1_000;

export type S3Config = Pick<
  Config,
  | "S3_ENDPOINT"
  | "S3_REGION"
  | "S3_BUCKET"
  | "S3_ACCESS_KEY_ID"
  | "S3_SECRET_ACCESS_KEY"
  | "S3_FORCE_PATH_STYLE"
  | "S3_PREFIX"
>;

type ErrorContext = "object" | "bucket";

function readProviderField(value: unknown, key: string): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return undefined;
  }
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function providerErrorCode(error: unknown): string | undefined {
  const upperCode = readProviderField(error, "Code");
  if (typeof upperCode === "string") return upperCode;
  const code = readProviderField(error, "code");
  if (typeof code === "string") return code;
  const name = readProviderField(error, "name");
  return typeof name === "string" && name !== "Error" ? name : undefined;
}

function providerStatus(error: unknown): number | undefined {
  const metadata = readProviderField(error, "$metadata");
  const status = readProviderField(metadata, "httpStatusCode");
  return typeof status === "number" ? status : undefined;
}

function isBucketMissingCode(code: string | undefined): boolean {
  return code === "NoSuchBucket" || code === "NoSuchBucketException";
}

function mapError(error: unknown, operation: string, context: ErrorContext): StorageError {
  if (error instanceof StorageError) {
    return new StorageError(error.code, operation, { bucketMissing: error.bucketMissing });
  }

  const code = providerErrorCode(error);
  if (isBucketMissingCode(code)) {
    return new StorageError("NotFound", operation, { bucketMissing: true });
  }
  const status = providerStatus(error);
  if (code === "PreconditionFailed" || code === "ConditionalRequestConflict" || status === 412) {
    return new StorageError("PreconditionFailed", operation);
  }
  if (
    code === "NotImplemented" ||
    code === "NotSupported" ||
    code === "UnsupportedOperation" ||
    status === 501
  ) {
    return new StorageError("Unsupported", operation);
  }
  if (code === "NoSuchKey" || code === "NoSuchObject" || code === "NotFound" || status === 404) {
    return new StorageError("NotFound", operation, { bucketMissing: context === "bucket" });
  }
  return new StorageError("Other", operation);
}

function isMissingObject(error: unknown): boolean {
  const code = providerErrorCode(error);
  if (isBucketMissingCode(code)) return false;
  return (
    code === "NoSuchKey" ||
    code === "NoSuchObject" ||
    code === "NotFound" ||
    providerStatus(error) === 404
  );
}

function isIdempotentDeleteError(code: string | undefined): boolean {
  return code === "NoSuchKey" || code === "NoSuchObject" || code === "NotFound";
}

function isDnsCompatibleBucket(bucket: string): boolean {
  if (bucket.length < 3 || bucket.length > 63 || bucket !== bucket.toLowerCase()) return false;
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u.test(bucket)) return false;
  if (bucket.includes("..") || /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(bucket)) return false;
  return bucket.split(".").every((label) => !label.startsWith("-") && !label.endsWith("-"));
}

function usesPathStyle(endpoint: URL, bucket: string, forcePathStyle: boolean): boolean {
  const hostname = endpoint.hostname.replace(/^\[|\]$/gu, "");
  return (
    forcePathStyle ||
    isIP(hostname) !== 0 ||
    !isDnsCompatibleBucket(bucket) ||
    (endpoint.protocol === "https:" && bucket.includes("."))
  );
}

function resolveBucketOrigin(
  endpointValue: string,
  bucket: string,
  forcePathStyle: boolean,
): string {
  const endpoint = new URL(endpointValue);
  if (!usesPathStyle(endpoint, bucket, forcePathStyle)) {
    endpoint.hostname = `${bucket}.${endpoint.hostname}`;
  }
  return endpoint.origin;
}

function safeReadable(source: Readable, operation: string): Readable {
  const proxy = new PassThrough();
  let failed = false;

  source.on("error", () => {
    if (failed) return;
    failed = true;
    source.unpipe(proxy);
    proxy.destroy(new StorageError("Other", operation));
  });
  source.pipe(proxy);
  proxy.on("close", () => {
    if (!proxy.readableEnded && !source.destroyed) source.destroy();
  });
  return proxy;
}

export class S3Storage implements Storage {
  readonly bucketOrigin: string;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly client: S3Client;

  constructor(config: S3Config) {
    this.bucket = config.S3_BUCKET;
    this.prefix = storagePrefix(config.S3_PREFIX);
    this.bucketOrigin = resolveBucketOrigin(
      config.S3_ENDPOINT,
      config.S3_BUCKET,
      config.S3_FORCE_PATH_STYLE,
    );
    this.client = new S3Client({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      credentials: {
        accessKeyId: config.S3_ACCESS_KEY_ID,
        secretAccessKey: config.S3_SECRET_ACCESS_KEY,
      },
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      requestHandler: {
        connectionTimeout: NETWORK_CONNECTION_TIMEOUT_MS,
      },
    });
  }

  private key(key: string): string {
    return `${this.prefix}${key}`;
  }

  async getJson<T>(key: string): Promise<T> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.key(key) }),
      );
      if (response.Body === undefined) throw new StorageError("Other", "getJson");
      const text = await response.Body.transformToString();
      return JSON.parse(text) as T;
    } catch (error) {
      throw mapError(error, "getJson", "object");
    }
  }

  async putJson(key: string, value: unknown, options: { ifNoneMatch?: "*" } = {}): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.key(key),
          Body: JSON.stringify(value),
          ContentType: "application/json",
          ...(options.ifNoneMatch === undefined ? {} : { IfNoneMatch: options.ifNoneMatch }),
        }),
      );
    } catch (error) {
      throw mapError(error, "putJson", "bucket");
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(key) }));
    } catch (error) {
      if (isMissingObject(error)) return;
      throw mapError(error, "delete", "bucket");
    }
  }

  async deleteMany(keys: string[]): Promise<void> {
    for (let start = 0; start < keys.length; start += DELETE_BATCH_SIZE) {
      const objects: Array<{ Key: string }> = [];
      const end = Math.min(keys.length, start + DELETE_BATCH_SIZE);
      for (let index = start; index < end; index += 1) {
        const key = keys[index];
        if (key === undefined) throw new StorageError("Other", "deleteMany");
        objects.push({ Key: this.key(key) });
      }
      try {
        const response = await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: objects, Quiet: true },
          }),
        );
        for (const error of response.Errors ?? []) {
          if (isBucketMissingCode(error.Code)) {
            throw new StorageError("NotFound", "deleteMany", { bucketMissing: true });
          }
          if (!isIdempotentDeleteError(error.Code)) {
            throw new StorageError("Other", "deleteMany");
          }
        }
      } catch (error) {
        throw mapError(error, "deleteMany", "bucket");
      }
    }
  }

  async *list(
    prefix: string,
    options: { startAfter?: string; maxKeys?: number } = {},
  ): AsyncIterable<StorageObject> {
    const qualifiedPrefix = this.key(prefix);
    const qualifiedStartAfter =
      options.startAfter === undefined ? undefined : this.key(options.startAfter);
    let continuationToken: string | undefined;
    let firstPage = true;
    for (;;) {
      try {
        const response = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: qualifiedPrefix,
            ...(firstPage && qualifiedStartAfter !== undefined
              ? { StartAfter: qualifiedStartAfter }
              : {}),
            ...(options.maxKeys === undefined ? {} : { MaxKeys: options.maxKeys }),
            ...(continuationToken === undefined ? {} : { ContinuationToken: continuationToken }),
          }),
        );

        for (const object of response.Contents ?? []) {
          if (
            object.Key === undefined ||
            !object.Key.startsWith(qualifiedPrefix) ||
            object.Size === undefined ||
            object.LastModified === undefined
          ) {
            throw new StorageError("Other", "list");
          }
          yield {
            key: object.Key.slice(this.prefix.length),
            size: object.Size,
            lastModified: object.LastModified,
          };
        }

        firstPage = false;
        if (response.IsTruncated !== true) return;
        const nextContinuationToken = response.NextContinuationToken;
        if (nextContinuationToken === undefined || nextContinuationToken === continuationToken) {
          throw new StorageError("Other", "list");
        }
        continuationToken = nextContinuationToken;
      } catch (error) {
        throw mapError(error, "list", "bucket");
      }
    }
  }

  async head(key: string): Promise<{ size: number } | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(key) }),
      );
      if (response.ContentLength === undefined) throw new StorageError("Other", "head");
      return { size: response.ContentLength };
    } catch (error) {
      if (isMissingObject(error)) return null;
      throw mapError(error, "head", "object");
    }
  }

  async presignPut(key: string, size: number, expiresSec: number): Promise<PresignedRequest> {
    try {
      const url = await getSignedUrl(
        this.client,
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.key(key),
          ContentLength: size,
        }),
        { expiresIn: expiresSec },
      );
      return { url, headers: { "Content-Length": String(size) } };
    } catch (error) {
      throw mapError(error, "presignPut", "bucket");
    }
  }

  async presignGet(key: string, expiresSec: number): Promise<PresignedRequest> {
    try {
      const url = await getSignedUrl(
        this.client,
        new GetObjectCommand({ Bucket: this.bucket, Key: this.key(key) }),
        { expiresIn: expiresSec },
      );
      return { url, headers: {} };
    } catch (error) {
      throw mapError(error, "presignGet", "bucket");
    }
  }

  async putStream(key: string, stream: Readable, size: number): Promise<void> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    // The SDK does not propagate a request body's error to the HTTP request.
    stream.once("error", abort);
    if (stream.errored !== null) abort();
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.key(key),
          Body: stream,
          ContentLength: size,
        }),
        { abortSignal: controller.signal },
      );
    } catch (error) {
      throw mapError(error, "putStream", "bucket");
    } finally {
      stream.off("error", abort);
    }
  }

  async getStream(key: string): Promise<Readable> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.key(key) }),
      );
      if (!(response.Body instanceof Readable)) throw new StorageError("Other", "getStream");
      return safeReadable(response.Body, "getStream");
    } catch (error) {
      throw mapError(error, "getStream", "object");
    }
  }

  async applyCors(origins: string[]): Promise<void> {
    try {
      await this.client.send(
        new PutBucketCorsCommand({
          Bucket: this.bucket,
          CORSConfiguration: {
            CORSRules: [
              {
                AllowedOrigins: origins,
                AllowedMethods: ["GET", "PUT", "HEAD"],
                AllowedHeaders: ["*"],
                ExposeHeaders: ["ETag"],
                MaxAgeSeconds: 3_600,
              },
            ],
          },
        }),
        { abortSignal: AbortSignal.timeout(CORS_REQUEST_TIMEOUT_MS) },
      );
    } catch (error) {
      throw mapError(error, "applyCors", "bucket");
    }
  }

  async getCors(): Promise<CorsRule[]> {
    try {
      const response = await this.client.send(new GetBucketCorsCommand({ Bucket: this.bucket }), {
        abortSignal: AbortSignal.timeout(CORS_REQUEST_TIMEOUT_MS),
      });
      return (response.CORSRules ?? []).map((rule) => ({
        allowedOrigins: [...(rule.AllowedOrigins ?? [])],
        allowedMethods: [...(rule.AllowedMethods ?? [])],
        allowedHeaders: [...(rule.AllowedHeaders ?? [])],
        exposeHeaders: [...(rule.ExposeHeaders ?? [])],
        maxAgeSeconds: rule.MaxAgeSeconds ?? 0,
      }));
    } catch (error) {
      throw mapError(error, "getCors", "bucket");
    }
  }

  destroy(): void {
    this.client.destroy();
  }
}
