import type { Readable } from "node:stream";

export type StorageErrorCode = "NotFound" | "PreconditionFailed" | "Unsupported" | "Other";

export class StorageError extends Error {
  readonly bucketMissing: boolean;

  constructor(
    readonly code: StorageErrorCode,
    operation: string,
    options: { bucketMissing?: boolean } = {},
  ) {
    super(`Storage ${operation} failed (${code})`);
    this.name = "StorageError";
    this.bucketMissing = options.bucketMissing ?? false;
  }
}

export interface StorageObject {
  key: string;
  size: number;
  lastModified: Date;
}

export interface PresignedRequest {
  url: string;
  headers: Record<string, string>;
}

export interface CorsRule {
  allowedOrigins: string[];
  allowedMethods: string[];
  allowedHeaders: string[];
  exposeHeaders: string[];
  maxAgeSeconds: number;
}

export interface Storage {
  readonly bucketOrigin: string;
  getJson<T>(key: string): Promise<T>;
  putJson(key: string, value: unknown, options?: { ifNoneMatch?: "*" }): Promise<void>;
  delete(key: string): Promise<void>;
  deleteMany(keys: string[]): Promise<void>;
  /** maxKeys is the backend page size, not a limit on the iterator. */
  list(
    prefix: string,
    options?: { startAfter?: string; maxKeys?: number },
  ): AsyncIterable<StorageObject>;
  head(key: string): Promise<{ size: number } | null>;
  presignPut(key: string, size: number, expiresSec: number): Promise<PresignedRequest>;
  presignGet(key: string, expiresSec: number): Promise<PresignedRequest>;
  putStream(key: string, stream: Readable, size: number): Promise<void>;
  getStream(key: string): Promise<Readable>;
  applyCors(origins: string[]): Promise<void>;
  getCors(): Promise<CorsRule[]>;
}

/** Treat a configured prefix as a namespace, including when it lacks the final slash. */
export function storagePrefix(prefix: string): string {
  return prefix === "" || prefix.endsWith("/") ? prefix : `${prefix}/`;
}
