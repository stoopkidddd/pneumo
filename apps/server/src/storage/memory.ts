import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  type CorsRule,
  type PresignedRequest,
  type Storage,
  StorageError,
  type StorageObject,
  storagePrefix,
} from "./types.js";

interface StoredObject {
  body: Buffer;
  lastModified: number;
}

interface MemoryBucketState {
  objects: Map<string, StoredObject>;
  cors: CorsRule[];
}

const bucketStates = new WeakMap<MemoryBucket, MemoryBucketState>();

/** A shared object namespace. Pass one bucket to multiple MemoryStorage views. */
export class MemoryBucket {
  constructor() {
    bucketStates.set(this, { objects: new Map(), cors: [] });
  }
}

interface SignedOperation {
  url: string;
  operation: "get" | "put";
  physicalKey: string;
  expiresAt: number;
  size?: number;
}

interface MemoryStorageState {
  bucket: MemoryBucketState;
  prefix: string;
  now: () => number;
  signedOperations: Map<string, SignedOperation>;
}

const storageStates = new WeakMap<MemoryStorage, MemoryStorageState>();

function stateFor(storage: MemoryStorage): MemoryStorageState {
  const state = storageStates.get(storage);
  if (!state) throw new StorageError("Other", "access memory state");
  return state;
}

function copyCorsRule(rule: CorsRule): CorsRule {
  return {
    allowedOrigins: [...rule.allowedOrigins],
    allowedMethods: [...rule.allowedMethods],
    allowedHeaders: [...rule.allowedHeaders],
    exposeHeaders: [...rule.exposeHeaders],
    maxAgeSeconds: rule.maxAgeSeconds,
  };
}

function storageFailure(operation: string): StorageError {
  return new StorageError("Other", operation);
}

export interface MemoryPresignedRequestInit {
  method: "GET" | "PUT";
  body?: Uint8Array;
  headers?: Record<string, string>;
}

/** Execute an opaque MemoryStorage presigned URL without putting it in logs. */
export async function useMemoryPresignedRequest(
  storage: MemoryStorage,
  request: PresignedRequest,
  init: MemoryPresignedRequestInit,
): Promise<Response> {
  const state = stateFor(storage);
  let token: string;
  try {
    const url = new URL(request.url);
    if (url.protocol !== "memory:" || url.hostname !== "presigned")
      return new Response(null, { status: 403 });
    token = url.pathname.slice(1);
  } catch {
    return new Response(null, { status: 403 });
  }

  const signed = state.signedOperations.get(token);
  if (!signed || signed.url !== request.url || state.now() >= signed.expiresAt) {
    return new Response(null, { status: 403 });
  }

  const expectedMethod = signed.operation === "put" ? "PUT" : "GET";
  if (init.method !== expectedMethod) return new Response(null, { status: 405 });

  if (signed.operation === "put") {
    const body = init.body ?? new Uint8Array();
    const headers = new Headers(init.headers);
    const contentLength = headers.get("content-length");
    if (contentLength !== String(signed.size)) return new Response(null, { status: 403 });
    if (body.byteLength !== signed.size) return new Response(null, { status: 400 });
    state.bucket.objects.set(signed.physicalKey, {
      body: Buffer.from(body),
      lastModified: state.now(),
    });
    return new Response(null, { status: 200 });
  }

  const object = state.bucket.objects.get(signed.physicalKey);
  if (!object) return new Response(null, { status: 404 });
  return new Response(Buffer.from(object.body), {
    status: 200,
    headers: { "content-length": String(object.body.byteLength) },
  });
}

export class MemoryStorage implements Storage {
  readonly bucketOrigin: string;

  constructor(
    options: {
      prefix?: string;
      bucket?: MemoryBucket;
      now?: () => number;
      bucketOrigin?: string;
    } = {},
  ) {
    this.bucketOrigin = options.bucketOrigin ?? "https://memory.invalid";
    const bucket = options.bucket ?? new MemoryBucket();
    const bucketState = bucketStates.get(bucket);
    if (!bucketState) throw storageFailure("initialize");
    storageStates.set(this, {
      bucket: bucketState,
      prefix: storagePrefix(options.prefix ?? ""),
      now: options.now ?? Date.now,
      signedOperations: new Map(),
    });
  }

  async getJson<T>(key: string): Promise<T> {
    const state = stateFor(this);
    const object = state.bucket.objects.get(`${state.prefix}${key}`);
    if (!object) throw new StorageError("NotFound", "get JSON");
    try {
      return JSON.parse(object.body.toString("utf8")) as T;
    } catch {
      throw storageFailure("get JSON");
    }
  }

  async putJson(key: string, value: unknown, options: { ifNoneMatch?: "*" } = {}): Promise<void> {
    const state = stateFor(this);
    const physicalKey = `${state.prefix}${key}`;
    if (options.ifNoneMatch === "*" && state.bucket.objects.has(physicalKey)) {
      throw new StorageError("PreconditionFailed", "put JSON");
    }
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch {
      throw storageFailure("put JSON");
    }
    if (serialized === undefined) throw storageFailure("put JSON");
    state.bucket.objects.set(physicalKey, {
      body: Buffer.from(serialized, "utf8"),
      lastModified: state.now(),
    });
  }

  async delete(key: string): Promise<void> {
    const state = stateFor(this);
    state.bucket.objects.delete(`${state.prefix}${key}`);
  }

  async deleteMany(keys: string[]): Promise<void> {
    const state = stateFor(this);
    for (const key of keys) state.bucket.objects.delete(`${state.prefix}${key}`);
  }

  async *list(
    prefix: string,
    options: { startAfter?: string; maxKeys?: number } = {},
  ): AsyncIterable<StorageObject> {
    const state = stateFor(this);
    const pageSize = options.maxKeys ?? 1_000;
    if (!Number.isSafeInteger(pageSize) || pageSize <= 0) throw storageFailure("list");

    const physicalPrefix = `${state.prefix}${prefix}`;
    const startAfter =
      options.startAfter === undefined ? undefined : Buffer.from(options.startAfter);
    const objects = [...state.bucket.objects.entries()]
      .filter(([physicalKey]) => physicalKey.startsWith(physicalPrefix))
      .map(([physicalKey, object]) => {
        const key = physicalKey.slice(state.prefix.length);
        return {
          key,
          sortKey: Buffer.from(key),
          size: object.body.byteLength,
          lastModified: object.lastModified,
        };
      })
      .filter(
        (object) => startAfter === undefined || Buffer.compare(object.sortKey, startAfter) > 0,
      )
      .sort((left, right) => Buffer.compare(left.sortKey, right.sortKey));

    for (let pageStart = 0; pageStart < objects.length; pageStart += pageSize) {
      const pageEnd = Math.min(pageStart + pageSize, objects.length);
      for (let index = pageStart; index < pageEnd; index += 1) {
        const object = objects[index];
        if (!object) throw storageFailure("list");
        yield {
          key: object.key,
          size: object.size,
          lastModified: new Date(object.lastModified),
        };
      }
    }
  }

  async head(key: string): Promise<{ size: number } | null> {
    const state = stateFor(this);
    const object = state.bucket.objects.get(`${state.prefix}${key}`);
    return object ? { size: object.body.byteLength } : null;
  }

  async presignPut(key: string, size: number, expiresSec: number): Promise<PresignedRequest> {
    return this.presign("put", key, expiresSec, size);
  }

  async presignGet(key: string, expiresSec: number): Promise<PresignedRequest> {
    return this.presign("get", key, expiresSec);
  }

  async putStream(key: string, stream: Readable, size: number): Promise<void> {
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk)
          ? chunk
          : typeof chunk === "string"
            ? Buffer.from(chunk)
            : Buffer.from(chunk as Uint8Array);
        total += bytes.byteLength;
        if (total > size) throw storageFailure("put stream");
        chunks.push(bytes);
      }
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw storageFailure("put stream");
    }
    if (total !== size) throw storageFailure("put stream");

    const state = stateFor(this);
    state.bucket.objects.set(`${state.prefix}${key}`, {
      body: Buffer.concat(chunks, total),
      lastModified: state.now(),
    });
  }

  async getStream(key: string): Promise<Readable> {
    const state = stateFor(this);
    const object = state.bucket.objects.get(`${state.prefix}${key}`);
    if (!object) throw new StorageError("NotFound", "get stream");
    return Readable.from([Buffer.from(object.body)]);
  }

  async applyCors(origins: string[]): Promise<void> {
    const state = stateFor(this);
    state.bucket.cors = [
      {
        allowedOrigins: [...origins],
        allowedMethods: ["GET", "PUT", "HEAD"],
        allowedHeaders: ["*"],
        exposeHeaders: ["ETag"],
        maxAgeSeconds: 3_600,
      },
    ];
  }

  async getCors(): Promise<CorsRule[]> {
    return stateFor(this).bucket.cors.map(copyCorsRule);
  }

  private async presign(
    operation: "get" | "put",
    key: string,
    expiresSec: number,
    size?: number,
  ): Promise<PresignedRequest> {
    const state = stateFor(this);
    const token = randomUUID();
    const url = `memory://presigned/${token}`;
    state.signedOperations.set(token, {
      url,
      operation,
      physicalKey: `${state.prefix}${key}`,
      expiresAt: state.now() + expiresSec * 1_000,
      ...(size === undefined ? {} : { size }),
    });
    return {
      url,
      headers: size === undefined ? {} : { "Content-Length": String(size) },
    };
  }
}
