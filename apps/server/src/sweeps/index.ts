import { Uuidv7 } from "@pneumo/protocol";
import type { Logger } from "pino";
import type { Clock } from "../app.js";
import type { Config } from "../config.js";
import type { FileRegistry } from "../files/registry.js";
import type { PushIndex } from "../index-store/index.js";
import type { Scheduler } from "../index-store/scheduler.js";
import type { Storage } from "../storage/types.js";

const FILE_PREFIX = "files/";
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const ORPHAN_AGE_MS = DAY_MS;

export interface SweepDependencies {
  storage: Storage;
  clock: Clock;
  config: Pick<Config, "RETENTION_DAYS">;
  pushes: PushIndex;
  files: Pick<FileRegistry, "pending" | "forget">;
  logger: Logger;
}

interface ScheduledSweepDependencies extends SweepDependencies {
  scheduler: Scheduler;
}

function fileIdFromKey(key: string): string | null {
  if (!key.startsWith(FILE_PREFIX)) return null;
  const id = key.slice(FILE_PREFIX.length);
  return Uuidv7.safeParse(id).success ? id : null;
}

export async function runOrphanSweep({
  storage,
  clock,
  pushes,
  files,
}: SweepDependencies): Promise<void> {
  await pushes.mutex.run(async () => {
    const cutoff = clock.now() - ORPHAN_AGE_MS;
    let expiredPending: Set<string> | null = null;
    for (const [id, pending] of files.pending) {
      if (pending.createdAt < cutoff) {
        expiredPending ??= new Set<string>();
        expiredPending.add(id);
      }
    }

    for await (const object of storage.list(FILE_PREFIX)) {
      const id = fileIdFromKey(object.key);
      if (id === null) continue;
      expiredPending?.delete(id);
      if (pushes.hasFile(id)) {
        const pending = files.pending.get(id);
        if (pending !== undefined && pending.createdAt < cutoff) files.forget(id);
        continue;
      }
      if (object.lastModified.getTime() >= cutoff) continue;
      const pending = files.pending.get(id);
      if (pending !== undefined && pending.createdAt >= cutoff) continue;
      await storage.delete(object.key);
      files.forget(id);
    }
    if (expiredPending !== null) {
      for (const id of expiredPending) files.forget(id);
    }
  });
}

export async function runRetentionSweep({
  clock,
  config,
  pushes,
  files,
}: SweepDependencies): Promise<void> {
  if (config.RETENTION_DAYS <= 0) return;
  await pushes.mutex.run(async () => {
    const cutoff = clock.now() - config.RETENTION_DAYS * DAY_MS;
    const records = pushes.all();
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index];
      if (record === undefined) throw new Error("Push index is inconsistent");
      if (Date.parse(record.createdAt) >= cutoff) break;
      if ((await pushes.remove(record.id)) && record.file !== null) {
        files.forget(record.file.id);
      }
    }
  });
}

export function startSweeps({
  scheduler,
  logger,
  ...deps
}: ScheduledSweepDependencies): () => void {
  const stopOrphans = scheduler.every(HOUR_MS, async () => {
    try {
      await runOrphanSweep({ ...deps, logger });
    } catch {
      logger.error("Orphan file sweep failed");
    }
  });
  const stopRetention =
    deps.config.RETENTION_DAYS > 0
      ? scheduler.every(DAY_MS, async () => {
          try {
            await runRetentionSweep({ ...deps, logger });
          } catch {
            logger.error("Push retention sweep failed");
          }
        })
      : () => undefined;
  return () => {
    stopOrphans();
    stopRetention();
  };
}
