import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { type ShutdownHook, shutdownServer } from "./http/shutdown.js";
import { createLogger } from "./log.js";

try {
  const config = loadConfig(process.env);
  const logger = createLogger(config.LOG_LEVEL);
  const shutdownHooks: ShutdownHook[] = [];
  const app = createApp({
    config,
    logger,
    storage: {},
    clock: { now: () => performance.now() },
    instanceState: { initialized: false },
  });
  const server = serve({ fetch: app.fetch, port: config.PORT }, ({ port }) => {
    logger.info({ port }, "Server listening");
  });
  server.on("error", () => {
    logger.fatal("Server failed to listen");
    process.exit(1);
  });

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void shutdownServer(server, shutdownHooks, logger).then((drained) => {
      process.exit(drained ? 0 : 1);
    });
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
} catch (error) {
  // Never print Zod issues, exception messages, or environment values.
  console.error(error instanceof ConfigError ? error.message : "Server failed to start");
  process.exit(1);
}
