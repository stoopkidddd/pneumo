import { PassThrough, Readable } from "node:stream";
import { inspect } from "node:util";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import type { getSignedUrl as GetSignedUrl } from "@aws-sdk/s3-request-presigner";
import { afterEach, expect, test, vi } from "vitest";
import { createLogger } from "../log.js";
import { type S3Config, S3Storage } from "./s3.js";
import { StorageError } from "./types.js";

const presignControl = vi.hoisted(() => ({ failure: undefined as unknown }));

vi.mock("@aws-sdk/s3-request-presigner", async (importOriginal) => {
  const actual = await importOriginal<{ getSignedUrl: typeof GetSignedUrl }>();
  return {
    ...actual,
    getSignedUrl: (...args: Parameters<typeof actual.getSignedUrl>) => {
      if (presignControl.failure !== undefined) return Promise.reject(presignControl.failure);
      return Reflect.apply(actual.getSignedUrl, undefined, args);
    },
  };
});

type Command = { input: Record<string, unknown> };

type SendImplementation = (command: Command) => Promise<unknown>;

function config(overrides: Partial<S3Config> = {}): S3Config {
  return {
    S3_ENDPOINT: "https://objects.example.test",
    S3_REGION: "eu-test-1",
    S3_BUCKET: "pneumo-bucket",
    S3_ACCESS_KEY_ID: "test-access-key",
    S3_SECRET_ACCESS_KEY: "test-secret-key",
    S3_FORCE_PATH_STYLE: false,
    S3_PREFIX: "tenant",
    ...overrides,
  };
}

function mockSend(implementation: SendImplementation) {
  return vi.spyOn(S3Client.prototype, "send").mockImplementation(implementation as never);
}

function assertStorageError(
  error: unknown,
  code: StorageError["code"],
  bucketMissing = false,
): void {
  expect(error).toBeInstanceOf(StorageError);
  expect(error).toMatchObject({ code, bucketMissing });
}

async function captureRejection(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to reject");
}

async function captureListRejection(storage: S3Storage): Promise<unknown> {
  try {
    for await (const _object of storage.list("objects/")) {
      // The mocked provider rejects before returning an object.
    }
  } catch (error) {
    return error;
  }
  throw new Error("Expected list to reject");
}

afterEach(() => {
  presignControl.failure = undefined;
  vi.restoreAllMocks();
});

test("deleteMany sends bounded batches and surfaces per-object failures", async () => {
  const batches: string[][] = [];
  mockSend(async (command) => {
    expect(command).toBeInstanceOf(DeleteObjectsCommand);
    const input = command.input as {
      Delete: { Objects: Array<{ Key: string }> };
    };
    batches.push(input.Delete.Objects.map((object) => object.Key));
    return {};
  });
  const storage = new S3Storage(config({ S3_PREFIX: "namespace/" }));
  const keys = Array.from({ length: 2_001 }, (_, index) => `key-${index}`);

  await storage.deleteMany(keys);

  expect(batches.map((batch) => batch.length)).toEqual([1_000, 1_000, 1]);
  expect(batches[0]?.[0]).toBe("namespace/key-0");
  expect(batches[2]?.[0]).toBe("namespace/key-2000");

  vi.restoreAllMocks();
  mockSend(async () => ({ Errors: [{ Key: "namespace/denied", Code: "AccessDenied" }] }));
  const error = await captureRejection(storage.deleteMany(["denied"]));
  assertStorageError(error, "Other");
  expect(inspect(error)).not.toContain("denied");
});

test("delete operations remain idempotent for absent objects", async () => {
  mockSend(async (command) => {
    if (command instanceof DeleteObjectCommand) {
      throw Object.assign(new Error("raw missing message"), {
        name: "NoSuchKey",
        $metadata: { httpStatusCode: 404 },
      });
    }
    return { Errors: [{ Code: "NoSuchKey", Key: "tenant/missing" }] };
  });
  const storage = new S3Storage(config());

  await expect(storage.delete("missing")).resolves.toBeUndefined();
  await expect(storage.deleteMany(["missing"])).resolves.toBeUndefined();
  await expect(storage.deleteMany([])).resolves.toBeUndefined();
});

test("list traverses every page, applies startAfter once, and strips only the storage prefix", async () => {
  const inputs: Array<Record<string, unknown>> = [];
  const firstModified = new Date("2026-01-01T00:00:00.000Z");
  const secondModified = new Date("2026-01-02T00:00:00.000Z");
  mockSend(async (command) => {
    expect(command).toBeInstanceOf(ListObjectsV2Command);
    inputs.push(command.input);
    if (inputs.length === 1) {
      return {
        Contents: [{ Key: "tenant/files/a", Size: 1, LastModified: firstModified }],
        IsTruncated: true,
        NextContinuationToken: "opaque-next-page",
      };
    }
    return {
      Contents: [{ Key: "tenant/files/é", Size: 2, LastModified: secondModified }],
      IsTruncated: false,
    };
  });
  const storage = new S3Storage(config());
  const objects = [];

  for await (const object of storage.list("files/", { startAfter: "files/0", maxKeys: 1 })) {
    objects.push(object);
  }

  expect(objects).toEqual([
    { key: "files/a", size: 1, lastModified: firstModified },
    { key: "files/é", size: 2, lastModified: secondModified },
  ]);
});

test("maps provider failure classes without retaining provider errors", async () => {
  const cases: Array<{
    provider: object;
    expectedCode: StorageError["code"];
    bucketMissing?: boolean;
  }> = [
    {
      provider: {
        name: "S3ServiceException",
        Code: "NoSuchBucket",
        message: "provider bucket detail",
      },
      expectedCode: "NotFound",
      bucketMissing: true,
    },
    {
      provider: { name: "NoSuchKey", message: "provider key detail" },
      expectedCode: "NotFound",
    },
    {
      provider: { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } },
      expectedCode: "PreconditionFailed",
    },
    {
      provider: { name: "NotImplemented", $metadata: { httpStatusCode: 501 } },
      expectedCode: "Unsupported",
    },
    {
      provider: { name: "EndpointError", message: "provider endpoint detail" },
      expectedCode: "Other",
    },
  ];

  for (const entry of cases) {
    mockSend(async () => {
      throw entry.provider;
    });
    const storage = new S3Storage(config());
    const operation =
      entry.bucketMissing === true
        ? storage.applyCors(["https://app.example.test"])
        : storage.getJson("missing.json");
    const error = await captureRejection(operation);
    assertStorageError(error, entry.expectedCode, entry.bucketMissing ?? false);
    expect(inspect(error)).not.toContain("provider");
    vi.restoreAllMocks();
  }
});

test("head returns null for a missing object but identifies a missing bucket", async () => {
  mockSend(async () => {
    throw Object.assign(new Error("not found"), {
      name: "NotFound",
      $metadata: { httpStatusCode: 404 },
    });
  });
  const storage = new S3Storage(config());
  await expect(storage.head("missing")).resolves.toBeNull();

  vi.restoreAllMocks();
  mockSend(async () => {
    throw Object.assign(new Error("bucket missing"), {
      name: "NoSuchBucket",
      $metadata: { httpStatusCode: 404 },
    });
  });
  const error = await captureRejection(storage.head("missing"));
  assertStorageError(error, "NotFound", true);
});

test("presigns virtual-host and path-style requests with region and content length", async () => {
  const virtual = new S3Storage(config());
  const put = await virtual.presignPut("uploads/file.bin", 123, 90);
  const putUrl = new URL(put.url);

  expect(virtual.bucketOrigin).toBe("https://pneumo-bucket.objects.example.test");
  expect(putUrl.host).toBe("pneumo-bucket.objects.example.test");
  expect(putUrl.pathname).toBe("/tenant/uploads/file.bin");
  expect(putUrl.searchParams.get("X-Amz-Credential")).toContain("/eu-test-1/s3/aws4_request");
  expect(putUrl.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toContain("content-length");
  expect(put.headers).toEqual({ "Content-Length": "123" });

  const path = new S3Storage(
    config({
      S3_ENDPOINT: "http://127.0.0.1:9000",
      S3_FORCE_PATH_STYLE: true,
      S3_BUCKET: "local-bucket",
      S3_PREFIX: "",
    }),
  );
  const get = await path.presignGet("download.bin", 30);
  const getUrl = new URL(get.url);
  expect(path.bucketOrigin).toBe("http://127.0.0.1:9000");
  expect(getUrl.host).toBe("127.0.0.1:9000");
  expect(getUrl.pathname).toBe("/local-bucket/download.bin");
  expect(get.headers).toEqual({});
});

test("sanitizes delayed download stream errors", async () => {
  const source = new PassThrough();
  mockSend(async () => ({ Body: source }));
  const storage = new S3Storage(config());

  const readable = await storage.getStream("download.bin");
  expect(readable).toBeInstanceOf(Readable);
  expect(readable).not.toBe(source);
  const { promise: emitted, resolve } = Promise.withResolvers<unknown>();
  readable.once("error", resolve);
  source.destroy(new Error("raw stream signed-url?X-Amz-Signature=stream-secret"));
  const error = await emitted;
  assertStorageError(error, "Other");
  expect(inspect(error)).not.toContain("stream-secret");
});

test("sanitizes an asynchronous proxy upload stream failure", async () => {
  const source = new PassThrough();
  mockSend(async (command) => {
    const body = command.input.Body;
    const { promise, reject } = Promise.withResolvers<unknown>();
    (body as Readable).once("error", reject);
    return promise;
  });
  const storage = new S3Storage(config());

  const upload = storage.putStream("upload.bin", source, 10);
  source.destroy(
    new Error("raw upload https://objects.example.test/file?X-Amz-Signature=upload-secret"),
  );
  const error = await captureRejection(upload);

  assertStorageError(error, "Other");
  expect(inspect(error, { showHidden: true })).not.toContain("upload-secret");
});

test("presign and list failures expose no raw URL or credentials in errors or logs", async () => {
  const signedUrl =
    "https://pneumo-bucket.objects.example.test/file?X-Amz-Credential=fake-access&X-Amz-Signature=fake-signature";
  const rawSecrets = [signedUrl, "fake-access", "fake-secret", "fake-signature"];
  const rawError = Object.assign(
    new Error(`provider failed at ${signedUrl} using fake-access and fake-secret`),
    {
      name: "EndpointError",
      endpoint: signedUrl,
      credentials: { accessKeyId: "fake-access", secretAccessKey: "fake-secret" },
    },
  );
  const storage = new S3Storage(
    config({ S3_ACCESS_KEY_ID: "fake-access", S3_SECRET_ACCESS_KEY: "fake-secret" }),
  );
  const lines: string[] = [];
  const logger = createLogger("info", { write: (message: string) => lines.push(message) });

  presignControl.failure = rawError;
  const presignError = await captureRejection(storage.presignPut("file", 10, 60));
  logger.error({ error: presignError }, "presign failed");

  mockSend(async () => {
    throw rawError;
  });
  const listError = await captureListRejection(storage);
  logger.error({ error: listError }, "list failed");

  assertStorageError(presignError, "Other");
  assertStorageError(listError, "Other");
  const exposed = [
    String(presignError),
    inspect(presignError, { showHidden: true, depth: 10 }),
    JSON.stringify(presignError),
    String(listError),
    inspect(listError, { showHidden: true, depth: 10 }),
    JSON.stringify(listError),
    lines.join(""),
  ].join("\n");
  for (const secret of rawSecrets) expect(exposed).not.toContain(secret);
});

test.each([
  ["http://127.0.0.1:9000", "pneumo-bucket"],
  ["https://objects.example.test:9443", "bucket.with.dots"],
  ["https://objects.example.test", "Underscored_Bucket"],
])("bucketOrigin follows the SDK's path-style fallback for %s / %s", async (endpoint, bucket) => {
  const storage = new S3Storage(config({ S3_ENDPOINT: endpoint, S3_BUCKET: bucket }));
  try {
    const request = await storage.presignGet("file", 60);
    // Compare origins without giving assertion reporters any signed query string.
    const actualOrigin = new URL(request.url).origin;
    expect(storage.bucketOrigin).toBe(actualOrigin);
    expect(actualOrigin).toBe(new URL(endpoint).origin);
  } finally {
    storage.destroy();
  }
});
