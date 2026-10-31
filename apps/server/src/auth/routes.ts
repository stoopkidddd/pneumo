import { isIP } from "node:net";
import { AuthParamsResponse, LoginRequest, SetupRequest } from "@pneumo/protocol";
import { Hono } from "hono";
import type { AppDependencies, AppEnv } from "../app.js";
import { errorResponse } from "../http/errors.js";
import { readJson, readJsonValue } from "../http/json.js";
import { Mutex } from "../instance/mutex.js";
import { LoginRateLimiter } from "./rate-limit.js";
import { verifyAuthKey } from "./verifier.js";

export function createAuthRoutes(deps: AppDependencies): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const limiter = new LoginRateLimiter(deps.clock);
  const loginMutex = new Mutex();

  routes.post("/setup", async (c) => {
    if (deps.instanceState.initialized) return errorResponse(c, "conflict");
    const body = await readJsonValue(c);
    const setupToken =
      body && typeof body === "object" && "setupToken" in body ? body.setupToken : null;
    if (!deps.instanceState.validSetupToken(setupToken)) return errorResponse(c, "forbidden");
    const parsed = SetupRequest.safeParse(body);
    if (!parsed.success) return errorResponse(c, "bad_request");
    if (!(await deps.instanceState.initialize(parsed.data))) return errorResponse(c, "conflict");
    return c.json(await deps.devices.create(parsed.data.device), 201);
  });

  routes.get("/auth/params", (c) => {
    const owner = deps.instanceState.owner;
    if (!owner) return errorResponse(c, "not_initialized");
    return c.json(AuthParamsResponse.parse({ kdf: owner.kdf }));
  });

  routes.post("/auth/login", async (c) => {
    const owner = deps.instanceState.owner;
    if (!owner) return errorResponse(c, "not_initialized");
    const body = await readJson(c, LoginRequest);
    const remoteAddress = c.env?.incoming?.socket.remoteAddress ?? "unknown";
    const forwarded = deps.config.TRUST_PROXY
      ? c.req.header("X-Forwarded-For")?.split(",", 1)[0]?.trim()
      : undefined;
    const ip = forwarded && isIP(forwarded) ? forwarded : remoteAddress;
    return loginMutex.run(async () => {
      const retryAfter = limiter.retryAfter(ip);
      if (retryAfter !== null) {
        c.header("Retry-After", String(retryAfter));
        return errorResponse(c, "rate_limited");
      }
      if (!(await verifyAuthKey(body.authKey, owner.authVerifier))) {
        limiter.failure(ip);
        return errorResponse(c, "unauthorized");
      }
      const result = await deps.devices.create(body.device);
      limiter.success(ip);
      return c.json(result, 201);
    });
  });
  return routes;
}
