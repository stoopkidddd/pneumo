import { serve } from "@hono/node-server";
import { createApp, systemClock } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { DeviceRegistry } from "./devices/registry.js";
import { EventBus } from "./events.js";
import { type ShutdownHook, shutdownServer } from "./http/shutdown.js";
import { InstanceState } from "./instance/state.js";
import { createLogger } from "./log.js";
import { S3Storage } from "./storage/s3.js";
import { resolveUploadMode } from "./storage/upload-mode.js";

try {
  const config = loadConfig(process.env);
  const logger = createLogger(config.LOG_LEVEL);
  const storage = new S3Storage(config);
  const uploadMode = await resolveUploadMode({
    storage,
    mode: config.UPLOAD_MODE,
    publicUrl: config.PUBLIC_URL,
    logger,
  });
  const instanceState = await InstanceState.load({ storage, config, clock: systemClock, logger });
  const devices = await DeviceRegistry.load({
    storage,
    clock: systemClock,
    events: new EventBus(),
  });
  const shutdownHooks: ShutdownHook[] = [];
  const app = createApp({
    config,
    logger,
    storage,
    uploadMode,
    clock: systemClock,
    instanceState,
    devices,
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
