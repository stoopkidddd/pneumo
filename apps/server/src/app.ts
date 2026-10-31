import { randomUUID } from "node:crypto";
import { serveStatic } from "@hono/node-server/serve-static";
import { HealthResponse } from "@pneumo/protocol";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Logger } from "pino";
import packageJson from "../package.json" with { type: "json" };
import type { Config } from "./config.js";
import { errorResponse, handleError } from "./http/errors.js";
import { securityHeaders, staticCacheControl } from "./http/headers.js";
import { createRequestLogger } from "./log.js";

// biome-ignore lint/suspicious/noEmptyInterface: ENG-249 supplies the storage contract; boot must not access the bucket yet.
export interface Storage {}

export interface Clock {
  now(): number;
}

export interface InstanceState {
  initialized: boolean;
}

export interface AppDependencies {
  config: Config;
  storage: Storage;
  clock: Clock;
  logger: Logger;
  instanceState: InstanceState;
  // Supplied by storage only when direct uploads are available.
  bucketOrigin?: string;
}

export type AppEnv = {
  Variables: {
    logger: Logger;
    requestId: string;
    staticPath?: string;
  };
};

export function createApp(deps: AppDependencies) {
  const app = new Hono<AppEnv>();
  app.onError(handleError);
  app.notFound((c) => errorResponse(c, "not_found"));

  app.use("*", async (c, next) => {
    const requestId = randomUUID();
    const logger = createRequestLogger(deps.logger, requestId);
    c.set("requestId", requestId);
    c.set("logger", logger);
    c.header("X-Request-Id", requestId);
    const startedAt = deps.clock.now();
    await next();
    logger.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Math.max(0, deps.clock.now() - startedAt),
      },
      "Request completed",
    );
  });
  app.use(
    "*",
    securityHeaders(
      deps.config.PUBLIC_URL,
      deps.config.UPLOAD_MODE === "proxy" ? undefined : deps.bucketOrigin,
    ),
  );
  const limitJson = bodyLimit({
    maxSize: 128 * 1024,
    onError: (c) => errorResponse(c, "payload_too_large"),
  });
  app.use("*", async (c, next) => {
    const mediaType = c.req.header("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType === "application/json" || mediaType?.endsWith("+json")) {
      return limitJson(c, next);
    }
    await next();
  });

  app.get("/api/health", (c) =>
    c.json(
      HealthResponse.parse({
        ok: true,
        version: packageJson.version,
        initialized: deps.instanceState.initialized,
      }),
    ),
  );
  app.all("/api", (c) => errorResponse(c, "not_found"));
  app.all("/api/*", (c) => errorResponse(c, "not_found"));

  app.use("*", async (c, next) => {
    await next();
    const path = c.get("staticPath");
    if (path) c.header("Cache-Control", staticCacheControl(path));
  });
  app.use(
    "*",
    serveStatic({
      root: deps.config.WEB_DIST_DIR,
      onFound: (path, c) => c.set("staticPath", path),
    }),
  );
  app.get(
    "*",
    serveStatic({
      root: deps.config.WEB_DIST_DIR,
      path: "index.html",
      onFound: (path, c) => c.set("staticPath", path),
    }),
  );

  return app;
}
