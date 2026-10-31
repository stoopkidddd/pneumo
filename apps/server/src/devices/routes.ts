import {
  DeviceDTO,
  ListDevicesResponse,
  MeResponse,
  SubscribeWebPushRequest,
  UpdateDeviceRequest,
} from "@pneumo/protocol";
import { Hono } from "hono";
import type { AppDependencies, AppEnv } from "../app.js";
import { bearerAuth } from "../auth/bearer.js";
import { errorResponse } from "../http/errors.js";
import { readJson } from "../http/json.js";

export function createDeviceRoutes(deps: AppDependencies): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const authenticate = bearerAuth(deps.devices);
  const meResponse = MeResponse.omit({ vapidPublicKey: true });

  routes.get("/me", authenticate, (c) => {
    const owner = deps.instanceState.owner;
    if (owner === null) return errorResponse(c, "not_initialized");

    const response = meResponse.parse({
      device: c.get("device"),
      keyCheck: owner.keyCheck,
      limits: {
        maxFileBytes: deps.config.MAX_FILE_BYTES,
        maxEnvelopeBytes: deps.config.MAX_ENVELOPE_BYTES,
      },
      uploadMode: deps.uploadMode,
    });
    return c.json({ ...response, vapidPublicKey: null });
  });

  routes.get("/devices", authenticate, (c) =>
    c.json(ListDevicesResponse.parse({ devices: deps.devices.list() })),
  );

  routes.patch("/devices/:id", authenticate, async (c) => {
    const request = await readJson(c, UpdateDeviceRequest);
    const device = await deps.devices.rename(c.req.param("id"), request.name);
    if (device === null) return errorResponse(c, "not_found");
    return c.json(DeviceDTO.parse(device));
  });

  routes.delete("/devices/:id", authenticate, async (c) => {
    if (!(await deps.devices.remove(c.req.param("id")))) {
      return errorResponse(c, "not_found");
    }
    return c.body(null, 204);
  });

  routes.put("/devices/self/webpush", authenticate, async (c) => {
    const request = await readJson(c, SubscribeWebPushRequest);
    if (!(await deps.devices.setWebPush(c.get("device").id, request.subscription))) {
      return errorResponse(c, "not_found");
    }
    return c.body(null, 204);
  });

  routes.delete("/devices/self/webpush", authenticate, async (c) => {
    if (!(await deps.devices.setWebPush(c.get("device").id, null))) {
      return errorResponse(c, "not_found");
    }
    return c.body(null, 204);
  });

  return routes;
}
