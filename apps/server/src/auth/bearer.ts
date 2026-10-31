import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app.js";
import type { DeviceRegistry } from "../devices/registry.js";
import { errorResponse } from "../http/errors.js";

export function bearerAuth(devices: DeviceRegistry): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const authorization = c.req.header("Authorization");
    const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/i);
    const device = match?.[1] ? await devices.authenticate(match[1]) : null;
    if (!device) return errorResponse(c, "unauthorized");
    c.set("device", device);
    await next();
  };
}
