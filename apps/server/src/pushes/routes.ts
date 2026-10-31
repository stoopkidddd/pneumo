import {
  CreatePushRequest,
  ListPushesQuery,
  ListPushesResponse,
  PushDTO,
  PushRecord,
  Uuidv7,
} from "@pneumo/protocol";
import { Hono } from "hono";
import type { AppDependencies, AppEnv } from "../app.js";
import { bearerAuth } from "../auth/bearer.js";
import { errorResponse } from "../http/errors.js";
import { readJson } from "../http/json.js";
import { pushObjectKey } from "../index-store/index.js";

function sameBody(record: PushRecord, request: CreatePushRequest): boolean {
  return (
    record.targetDeviceId === request.targetDeviceId &&
    record.envelope.v === request.envelope.v &&
    record.envelope.n === request.envelope.n &&
    record.envelope.c === request.envelope.c &&
    (record.file?.id ?? null) === (request.file?.id ?? null)
  );
}

export function createPushRoutes(deps: AppDependencies): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const authenticate = bearerAuth(deps.devices);

  routes.post("/pushes", authenticate, async (c) => {
    const request = await readJson(c, CreatePushRequest);
    if (
      Buffer.byteLength(JSON.stringify(request.envelope), "utf8") > deps.config.MAX_ENVELOPE_BYTES
    ) {
      return errorResponse(c, "payload_too_large");
    }
    const createdAt = new Date(deps.clock.now()).toISOString();
    return deps.pushes.mutex.run(async () => {
      const stored = deps.pushes.get(request.id);
      if (stored !== null) {
        return sameBody(stored, request)
          ? c.json(PushDTO.parse(stored), 200)
          : errorResponse(c, "conflict");
      }
      if (request.targetDeviceId !== null && deps.devices.get(request.targetDeviceId) === null) {
        return errorResponse(c, "bad_request");
      }
      let file: PushRecord["file"] = null;
      if (request.file !== null) {
        const pending = deps.files.pending.get(request.file.id);
        if (pending?.attached || deps.pushes.hasFile(request.file.id)) {
          return errorResponse(c, "conflict");
        }
        if (pending === undefined || pending.uploading) return errorResponse(c, "bad_request");
        const object = await deps.storage.head(`files/${request.file.id}`);
        if (object === null || object.size !== pending.size) return errorResponse(c, "bad_request");
        file = { id: request.file.id, size: pending.size };
      }
      const record = PushRecord.parse({
        ...request,
        v: 1,
        createdAt,
        sourceDeviceId: c.get("device").id,
        file,
      });
      await deps.storage.putJson(pushObjectKey(record), record);
      if (file !== null) deps.files.markAttached(file.id);
      deps.pushes.add(record);
      return c.json(PushDTO.parse(record), 201);
    });
  });

  routes.get("/pushes", authenticate, (c) => {
    const query = ListPushesQuery.safeParse(c.req.query());
    if (!query.success) return errorResponse(c, "bad_request");
    return c.json(ListPushesResponse.parse(deps.pushes.list(query.data.before, query.data.limit)));
  });

  routes.get("/pushes/:id", authenticate, (c) => {
    const id = Uuidv7.safeParse(c.req.param("id"));
    if (!id.success) return errorResponse(c, "bad_request");
    const record = deps.pushes.get(id.data);
    return record === null ? errorResponse(c, "not_found") : c.json(PushDTO.parse(record));
  });

  routes.delete("/pushes/:id", authenticate, async (c) => {
    const id = Uuidv7.safeParse(c.req.param("id"));
    if (!id.success) return errorResponse(c, "bad_request");
    return deps.pushes.mutex.run(async () => {
      const record = deps.pushes.get(id.data);
      if (record === null || !(await deps.pushes.remove(id.data)))
        return errorResponse(c, "not_found");
      if (record.file !== null) deps.files.forget(record.file.id);
      return c.body(null, 204);
    });
  });

  return routes;
}
