import { randomBytes } from "node:crypto";
import { ClaimPairRequest, ClaimPairResponse, CreatePairResponse } from "@pneumo/protocol";
import { Hono } from "hono";
import type { AppDependencies, AppEnv } from "../app.js";
import { bearerAuth } from "../auth/bearer.js";
import { errorResponse } from "../http/errors.js";
import { readJson } from "../http/json.js";

const PAIR_LIFETIME_MS = 10 * 60 * 1_000;

export function createPairingRoutes(deps: AppDependencies): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const authenticate = bearerAuth(deps.devices);
  const pairs = new Map<string, number>();

  routes.post("/pair", authenticate, (c) => {
    const now = deps.clock.now();
    for (const [code, expiresAt] of pairs) {
      if (expiresAt <= now) pairs.delete(code);
    }

    let code = randomBytes(16).toString("base64url");
    while (pairs.has(code)) code = randomBytes(16).toString("base64url");
    const expiresAt = now + PAIR_LIFETIME_MS;
    pairs.set(code, expiresAt);

    return c.json(
      CreatePairResponse.parse({ code, expiresAt: new Date(expiresAt).toISOString() }),
      201,
    );
  });

  routes.post("/pair/claim", async (c) => {
    const request = await readJson(c, ClaimPairRequest);
    if (request.device.platform !== "android") return errorResponse(c, "bad_request");

    const expiresAt = pairs.get(request.code);
    if (expiresAt === undefined) return errorResponse(c, "gone");
    pairs.delete(request.code);
    if (expiresAt <= deps.clock.now()) return errorResponse(c, "gone");

    const response = await deps.devices.create(request.device);
    return c.json(ClaimPairResponse.parse(response), 201);
  });

  return routes;
}
