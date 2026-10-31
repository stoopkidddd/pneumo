import type { ServerType } from "@hono/node-server";
import type { Logger } from "pino";

export type ShutdownHook = (closeCode: 1012) => void | Promise<void>;

export async function shutdownServer(
  server: ServerType,
  hooks: readonly ShutdownHook[],
  logger: Logger,
): Promise<boolean> {
  const expired = Promise.withResolvers<false>();
  const deadline = setTimeout(() => {
    if ("closeAllConnections" in server) server.closeAllConnections();
    logger.warn("Shutdown deadline reached");
    expired.resolve(false);
  }, 10_000);
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  const drained = Promise.all([
    closed.promise,
    ...hooks.map(async (hook) => {
      try {
        await hook(1012);
      } catch {
        logger.error("Shutdown hook failed");
      }
    }),
  ]).then(() => true as const);
  const result = await Promise.race([drained, expired.promise]);
  clearTimeout(deadline);
  return result;
}
