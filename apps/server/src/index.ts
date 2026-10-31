import { serve } from "@hono/node-server";
import { createApp, systemClock } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { DeviceRegistry } from "./devices/registry.js";
import { EventBus } from "./events.js";
import { FileRegistry } from "./files/registry.js";
import { type ShutdownHook, shutdownServer } from "./http/shutdown.js";
import { PushIndex, startReconciliation } from "./index-store/index.js";
import { systemScheduler } from "./index-store/scheduler.js";
import { InstanceState } from "./instance/state.js";
import { createLogger } from "./log.js";
import { S3Storage } from "./storage/s3.js";
import { resolveUploadMode } from "./storage/upload-mode.js";
import { startSweeps } from "./sweeps/index.js";
import { loadVapidKeys } from "./webpush/vapid.js";
import { attachWebSocketHub } from "./ws/hub.js";

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
  const vapidKeys = await loadVapidKeys({ storage, config });
  const events = new EventBus();
  const devices = await DeviceRegistry.load({
    storage,
    clock: systemClock,
    events,
  });
  const pushes = await PushIndex.load({ storage, events });
  const files = new FileRegistry();
  const shutdownHooks: ShutdownHook[] = [
    startReconciliation({ pushes, scheduler: systemScheduler, logger }),
    startSweeps({
      storage,
      clock: systemClock,
      config,
      pushes,
      files,
      scheduler: systemScheduler,
      logger,
    }),
  ];
  const app = createApp({
    config,
    logger,
    storage,
    uploadMode,
    clock: systemClock,
    instanceState,
    devices,
    pushes,
    files,
    vapidPublicKey: vapidKeys.publicKey,
  });
  const server = serve({ fetch: app.fetch, port: config.PORT }, ({ port }) => {
    logger.info({ port }, "Server listening");
  });
  shutdownHooks.push(
    attachWebSocketHub({
      server,
      devices,
      pushes,
      events,
      clock: systemClock,
      logger,
      pingSeconds: config.WS_PING_SECONDS,
    }),
  );
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
