import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import {
  CreateFileRequest,
  CreateFileResponse,
  GetFileResponse,
  isUuidv7,
  uuidv7,
} from "@pneumo/protocol";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppDependencies, AppEnv } from "../app.js";
import { bearerAuth } from "../auth/bearer.js";
import { errorResponse } from "../http/errors.js";
import { readJson } from "../http/json.js";
import { StorageError } from "../storage/types.js";

const PUT_EXPIRES_SECONDS = 60 * 60;
const GET_EXPIRES_SECONDS = 10 * 60;

function objectKey(id: string): string {
  return `files/${id}`;
}

function expiresAt(now: number, seconds: number): string {
  return new Date(now + seconds * 1_000).toISOString();
}

function knownSize(deps: AppDependencies, id: string): number | null {
  const pending = deps.files.pending.get(id);
  if (pending) return pending.size;
  return deps.pushes.fileSize(id);
}

function parseContentLength(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (!/^(0|[1-9]\d*)$/u.test(value)) throw new HTTPException(400);
  const length = Number(value);
  if (!Number.isSafeInteger(length)) throw new HTTPException(400);
  return length;
}

function validatedUpload(request: Request, expected: number, maximum: number) {
  const validation: { code: "bad_request" | "payload_too_large" | null } = { code: null };
  async function* chunks() {
    const reader = request.body?.getReader();
    let bytes = 0;
    try {
      if (reader) {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > maximum) {
            validation.code = "payload_too_large";
            throw new Error("Upload exceeds the configured byte limit");
          }
          if (bytes > expected) {
            validation.code = "bad_request";
            throw new Error("Upload size differs from its reservation");
          }
          yield chunk.value;
        }
      }
      if (bytes !== expected) throw new Error("Upload size differs from its reservation");
    } catch {
      validation.code ??= "bad_request";
      throw new Error("Invalid upload body");
    } finally {
      reader?.releaseLock();
    }
  }
  // Read only when storage consumes the stream, after its error handlers are installed.
  return { stream: Readable.from(chunks(), { objectMode: false }), validation };
}

export function createFileRoutes(deps: AppDependencies): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const authenticate = bearerAuth(deps.devices);

  routes.post("/files", authenticate, async (c) => {
    const request = await readJson(c, CreateFileRequest);
    if (request.size > deps.config.MAX_FILE_BYTES) {
      return errorResponse(c, "payload_too_large");
    }

    const response = await deps.pushes.mutex.run(async () => {
      let fileId = uuidv7();
      while (
        deps.files.pending.has(fileId) ||
        deps.pushes.hasFile(fileId) ||
        (await deps.storage.head(objectKey(fileId))) !== null
      ) {
        fileId = uuidv7();
      }

      const upload =
        deps.uploadMode === "direct"
          ? await deps.storage.presignPut(objectKey(fileId), request.size, PUT_EXPIRES_SECONDS)
          : { url: `/api/files/${fileId}/content`, headers: {} };
      const createdAt = deps.clock.now();
      const result = CreateFileResponse.parse({
        fileId,
        upload: { method: "PUT", ...upload },
        expiresAt: expiresAt(createdAt, PUT_EXPIRES_SECONDS),
      });
      deps.files.pending.set(fileId, {
        size: request.size,
        createdAt,
        attached: false,
      });
      return result;
    });

    return c.json(response, 201);
  });

  routes.put("/files/:id/content", authenticate, async (c) => {
    if (deps.uploadMode !== "proxy") return errorResponse(c, "not_found");
    const id = c.req.param("id");
    if (!isUuidv7(id)) return errorResponse(c, "not_found");

    return deps.pushes.mutex.run(async () => {
      const pending = deps.files.pending.get(id);
      if (!pending) {
        return errorResponse(c, deps.pushes.hasFile(id) ? "conflict" : "not_found");
      }
      if (pending.attached || deps.pushes.hasFile(id)) return errorResponse(c, "conflict");

      const contentLength = parseContentLength(c.req.header("Content-Length"));
      if (contentLength !== null && contentLength > deps.config.MAX_FILE_BYTES) {
        return errorResponse(c, "payload_too_large");
      }
      if (contentLength !== null && contentLength !== pending.size) {
        return errorResponse(c, "bad_request");
      }

      const { stream, validation } = validatedUpload(
        c.req.raw,
        pending.size,
        deps.config.MAX_FILE_BYTES,
      );
      const completed = finished(stream, { cleanup: true });
      void completed.catch(() => {});
      try {
        await deps.storage.putStream(objectKey(id), stream, pending.size);
        // Some object stores resolve after Content-Length bytes without reading EOF.
        // Drain anything they left behind and do not acknowledge until the request ended.
        stream.resume();
        await completed;
      } catch (error) {
        stream.destroy();
        await deps.storage.delete(objectKey(id));
        if (validation.code !== null) return errorResponse(c, validation.code);
        throw error;
      }
      return c.body(null, 204);
    });
  });

  routes.get("/files/:id", authenticate, async (c) => {
    const id = c.req.param("id");
    if (!isUuidv7(id)) return errorResponse(c, "not_found");
    const size = knownSize(deps, id);
    if (size === null) return errorResponse(c, "not_found");
    const stored = await deps.storage.head(objectKey(id));
    if (stored?.size !== size) return errorResponse(c, "not_found");

    const download =
      deps.uploadMode === "direct"
        ? await deps.storage.presignGet(objectKey(id), GET_EXPIRES_SECONDS)
        : { url: `/api/files/${id}/content`, headers: {} };
    return c.json(
      GetFileResponse.parse({
        download,
        expiresAt: expiresAt(deps.clock.now(), GET_EXPIRES_SECONDS),
      }),
    );
  });

  routes.get("/files/:id/content", authenticate, async (c) => {
    if (deps.uploadMode !== "proxy") return errorResponse(c, "not_found");
    const id = c.req.param("id");
    if (!isUuidv7(id)) return errorResponse(c, "not_found");
    const size = knownSize(deps, id);
    if (size === null) return errorResponse(c, "not_found");
    const stored = await deps.storage.head(objectKey(id));
    if (stored?.size !== size) return errorResponse(c, "not_found");

    let source: Readable;
    try {
      source = await deps.storage.getStream(objectKey(id));
    } catch (error) {
      if (error instanceof StorageError && error.code === "NotFound") {
        return errorResponse(c, "not_found");
      }
      throw error;
    }
    c.header("Content-Type", "application/octet-stream");
    c.header("Content-Length", String(size));
    return c.body(Readable.toWeb(source) as ReadableStream<Uint8Array>);
  });

  return routes;
}
