import type { Logger } from "pino";
import { type Storage, StorageError } from "./types.js";

export type UploadMode = "direct" | "proxy";

export async function resolveUploadMode({
  storage,
  mode,
  publicUrl,
  logger,
}: {
  storage: Storage;
  mode: "auto" | UploadMode;
  publicUrl: string;
  logger: Logger;
}): Promise<UploadMode> {
  if (mode !== "auto") return mode;

  // minio-init can create the bucket shortly after the server starts.
  const deadline = Date.now() + 10_000;
  let operation: "applyCors" | "getCors" = "applyCors";
  for (;;) {
    try {
      operation = "applyCors";
      await storage.applyCors([publicUrl]);
      operation = "getCors";
      await storage.getCors();
      logger.info(
        { uploadMode: "direct" },
        "Bucket CORS configured and read back; using direct uploads",
      );
      return "direct";
    } catch (error) {
      const remaining = deadline - Date.now();
      if (error instanceof StorageError && error.bucketMissing && remaining > 0) {
        const retry = Promise.withResolvers<void>();
        setTimeout(retry.resolve, Math.min(1000, remaining));
        await retry.promise;
        continue;
      }
      logger.warn(
        {
          uploadMode: "proxy",
          operation,
          reason: error instanceof StorageError ? error.code : "Other",
          bucketMissing: error instanceof StorageError && error.bucketMissing,
        },
        "Bucket CORS unavailable; using proxy uploads",
      );
      return "proxy";
    }
  }
}
