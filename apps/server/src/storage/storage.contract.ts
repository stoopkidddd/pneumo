import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, describe, expect, test } from "vitest";
import { type PresignedRequest, type Storage, StorageError } from "./types.js";

export interface StorageBackend {
  storage: Storage;
  close?: () => void | Promise<void>;
}

export type StorageBackendFactory = (prefix: string) => StorageBackend | Promise<StorageBackend>;

export interface PresignedUseOptions {
  method: "GET" | "PUT";
  body?: Uint8Array;
  /** These values override same-named headers from the signed request. */
  headers?: Record<string, string>;
}

/** Sends the signed headers plus any explicit overrides and returns the remote response. */
export type UsePresignedRequest = (
  storage: Storage,
  request: PresignedRequest,
  options: PresignedUseOptions,
) => Promise<Response>;

export function storageContract(
  backendName: string,
  createBackend: StorageBackendFactory,
  usePresignedRequest: UsePresignedRequest,
): void {
  describe(`${backendName} storage contract`, () => {
    const openBackends: StorageBackend[] = [];

    afterEach(async () => {
      await Promise.all(
        openBackends.splice(0).map(async (backend) => {
          await backend.close?.();
        }),
      );
    });

    async function open(prefix: string): Promise<Storage> {
      const backend = await createBackend(prefix);
      openBackends.push(backend);
      return backend.storage;
    }

    test("stores JSON snapshots and supports head, delete, and deleteMany", async () => {
      const storage = await open(`contract/${randomUUID()}`);
      const value = { nested: { enabled: true }, values: [1, 2, 3] };
      const snapshot = structuredClone(value);

      await storage.putJson("first.json", value);
      value.nested.enabled = false;
      value.values.push(4);

      expect(await storage.getJson("first.json")).toEqual(snapshot);
      expect(await storage.head("first.json")).toEqual({
        size: Buffer.byteLength(JSON.stringify(snapshot)),
      });
      expect(await storage.head("missing.json")).toBeNull();
      await expect(storage.getJson("missing.json")).rejects.toMatchObject({ code: "NotFound" });

      await storage.putJson("second.json", { second: true });
      await storage.putJson("third.json", { third: true });
      await storage.delete("first.json");
      await expect(storage.getJson("first.json")).rejects.toMatchObject({ code: "NotFound" });
      await storage.deleteMany(["second.json", "third.json", "already-missing.json"]);
      expect(await storage.head("second.json")).toBeNull();
      expect(await storage.head("third.json")).toBeNull();
    });

    test("lists every UTF-8 ordered page and honors startAfter", async () => {
      const storage = await open(`contract/${randomUUID()}`);
      const keys = ["items/\u{10000}", "items/a", "items/\uE000", "items/é", "items/\u007f"];
      for (const key of keys) await storage.putJson(key, { key });

      const expected = keys
        .map((key) => ({ key, bytes: Buffer.from(key) }))
        .sort((left, right) => Buffer.compare(left.bytes, right.bytes))
        .map(({ key }) => key);
      const listed: string[] = [];
      for await (const object of storage.list("items/", { maxKeys: 2 })) {
        listed.push(object.key);
        expect(object.size).toBeGreaterThan(0);
        expect(Number.isNaN(object.lastModified.getTime())).toBe(false);
      }
      expect(listed).toEqual(expected);

      const after: string[] = [];
      for await (const object of storage.list("items/", {
        startAfter: "items/a",
        maxKeys: 2,
      })) {
        after.push(object.key);
      }
      expect(after).toEqual(expected.slice(expected.indexOf("items/a") + 1));
    });

    test("isolates two namespaces in one bucket and normalizes a prefix without a slash", async () => {
      const rootPrefix = `contract/${randomUUID()}/`;
      const bucketView = await open("");
      const alpha = await open(`${rootPrefix}alpha`);
      const beta = await open(`${rootPrefix}beta/`);

      await alpha.putJson("item.json", { namespace: "alpha" });
      await beta.putJson("item.json", { namespace: "beta" });

      expect(await alpha.getJson("item.json")).toEqual({ namespace: "alpha" });
      expect(await beta.getJson("item.json")).toEqual({ namespace: "beta" });
      const physicalKeys: string[] = [];
      for await (const object of bucketView.list(rootPrefix, { maxKeys: 1 })) {
        physicalKeys.push(object.key);
      }
      expect(physicalKeys).toEqual([`${rootPrefix}alpha/item.json`, `${rootPrefix}beta/item.json`]);
    });

    test("conditionally creates an object without replacing an existing value", async ({
      skip,
    }) => {
      const storage = await open(`contract/${randomUUID()}`);
      try {
        await storage.putJson("conditional.json", { version: 1 }, { ifNoneMatch: "*" });
        await storage.putJson("conditional.json", { version: 2 }, { ifNoneMatch: "*" });
      } catch (error) {
        if (error instanceof StorageError && error.code === "Unsupported") {
          skip("Backend reports conditional create as unsupported");
          return;
        }
        expect(error).toBeInstanceOf(StorageError);
        expect(error).toMatchObject({ code: "PreconditionFailed" });
        expect(await storage.getJson("conditional.json")).toEqual({ version: 1 });
        return;
      }
      expect.fail("Conditional create replaced an existing object");
    });

    test("uses signed PUT and GET requests and rejects a changed content length", async () => {
      const storage = await open(`contract/${randomUUID()}`);
      const payload = Buffer.from("signed object payload", "utf8");
      const putRequest = await storage.presignPut("signed.bin", payload.byteLength, 60);
      const putResponse = await usePresignedRequest(storage, putRequest, {
        method: "PUT",
        body: payload,
      });
      expect(putResponse.ok).toBe(true);
      await putResponse.body?.cancel();
      expect(await storage.head("signed.bin")).toEqual({ size: payload.byteLength });

      const getRequest = await storage.presignGet("signed.bin", 60);
      const getResponse = await usePresignedRequest(storage, getRequest, { method: "GET" });
      expect(getResponse.ok).toBe(true);
      expect(Buffer.from(await getResponse.arrayBuffer())).toEqual(payload);

      const wrongPayload = Buffer.from("wrong length", "utf8");
      const wrongRequest = await storage.presignPut(
        "wrong-length.bin",
        wrongPayload.byteLength - 1,
        60,
      );
      const wrongResponse = await usePresignedRequest(storage, wrongRequest, {
        method: "PUT",
        body: wrongPayload,
        headers: { "Content-Length": String(wrongPayload.byteLength) },
      });
      expect(wrongResponse.ok).toBe(false);
      await wrongResponse.body?.cancel();
      expect(await storage.head("wrong-length.bin")).toBeNull();
    });

    test("round-trips a five-megabyte stream", async () => {
      const storage = await open(`contract/${randomUUID()}`);
      const payload = Buffer.allocUnsafe(5 * 1024 * 1024);
      for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251;

      await storage.putStream("large.bin", Readable.from([payload]), payload.byteLength);
      const stream = await storage.getStream("large.bin");
      expect(stream).toBeInstanceOf(Readable);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(
          Buffer.isBuffer(chunk)
            ? chunk
            : typeof chunk === "string"
              ? Buffer.from(chunk)
              : Buffer.from(chunk as Uint8Array),
        );
      }
      expect(Buffer.concat(chunks).equals(payload)).toBe(true);
      await expect(storage.getStream("missing.bin")).rejects.toMatchObject({ code: "NotFound" });
    });
  });
}
