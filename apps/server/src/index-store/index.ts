import {
  type PushDTO,
  PushRecord,
  parsePushObjectKey,
  pushObjectKey as protocolPushObjectKey,
} from "@pneumo/protocol";
import type { Logger } from "pino";
import type { EventBus } from "../events.js";
import { Mutex } from "../instance/mutex.js";
import type { Storage } from "../storage/types.js";
import type { Scheduler } from "./scheduler.js";

const PUSH_PREFIX = "pushes/";
const LOAD_CONCURRENCY = 32;
const RECONCILIATION_INTERVAL_MS = 30_000;
const RECONCILIATION_KEY_LIMIT = 100;

interface PushIndexDependencies {
  storage: Storage;
  events: EventBus;
}

interface PersistedPushKey {
  key: string;
  id: string;
  createdAtMs: number;
}

interface ReconciliationDependencies {
  pushes: PushIndex;
  scheduler: Scheduler;
  logger: Logger;
}

function toDTO(record: PushRecord): PushDTO {
  return {
    id: record.id,
    createdAt: record.createdAt,
    sourceDeviceId: record.sourceDeviceId,
    targetDeviceId: record.targetDeviceId,
    envelope: record.envelope,
    file: record.file,
  };
}

function comparePushes(left: PushRecord, right: PushRecord): number {
  if (left.createdAt !== right.createdAt) return left.createdAt > right.createdAt ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id > right.id ? -1 : 1;
}

function parsePersistedKey(key: string): PersistedPushKey {
  const parsed = parsePushObjectKey(key);
  if (parsed === null) throw new Error("Invalid persisted push object key");
  return { key, ...parsed };
}

function parsePersistedRecord(value: unknown, persisted: PersistedPushKey): PushRecord {
  const parsed = PushRecord.safeParse(value);
  if (!parsed.success) throw new Error("Invalid persisted push record");
  const record = parsed.data;
  if (record.id !== persisted.id || Date.parse(record.createdAt) !== persisted.createdAtMs) {
    throw new Error("Invalid persisted push record");
  }
  return record;
}

async function loadPersistedRecords(
  storage: Storage,
  keys: readonly PersistedPushKey[],
): Promise<PushRecord[]> {
  const records = new Array<PushRecord>(keys.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < keys.length) {
      const index = nextIndex;
      nextIndex += 1;
      const persisted = keys[index];
      if (persisted === undefined) throw new Error("Invalid persisted push record");
      const value = await storage.getJson<unknown>(persisted.key);
      records[index] = parsePersistedRecord(value, persisted);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(LOAD_CONCURRENCY, keys.length) }, () => worker()),
  );
  return records;
}

export function pushObjectKey(record: Pick<PushRecord, "id" | "createdAt">): string {
  return protocolPushObjectKey(Date.parse(record.createdAt), record.id);
}

export class PushIndex {
  readonly mutex = new Mutex();
  private readonly byId = new Map<string, PushRecord>();
  private readonly fileReferences = new Map<string, number>();
  private readonly ordered: PushRecord[] = [];

  private constructor(private readonly deps: PushIndexDependencies) {}

  static async load(deps: PushIndexDependencies): Promise<PushIndex> {
    const keys: PersistedPushKey[] = [];
    for await (const object of deps.storage.list(PUSH_PREFIX)) {
      keys.push(parsePersistedKey(object.key));
    }
    const records = await loadPersistedRecords(deps.storage, keys);
    records.sort(comparePushes);
    const index = new PushIndex(deps);
    for (const record of records) {
      if (index.byId.has(record.id)) throw new Error("Invalid persisted push record");
      index.byId.set(record.id, record);
      index.ordered.push(record);
      if (record.file !== null && !index.addFileReference(record.file.id, record.file.size)) {
        throw new Error("Invalid persisted push record");
      }
    }
    return index;
  }

  get(id: string): PushRecord | null {
    return this.byId.get(id) ?? null;
  }

  add(record: PushRecord): boolean {
    if (this.byId.has(record.id)) return false;
    const index = this.insertionIndex(record);
    if (record.file !== null && !this.addFileReference(record.file.id, record.file.size)) {
      throw new Error("Push file reference is inconsistent");
    }
    this.ordered.splice(index, 0, record);
    this.byId.set(record.id, record);
    this.deps.events.emit("push", { push: toDTO(record) });
    return true;
  }

  list(before?: string, limit = 50): { pushes: PushDTO[]; nextBefore: string | null } {
    let start = 0;
    if (before !== undefined) {
      const cursor = this.byId.get(before);
      if (cursor === undefined) return { pushes: [], nextBefore: null };
      start = this.findIndex(cursor) + 1;
    }
    const end = Math.min(start + limit, this.ordered.length);
    const pushes = new Array<PushDTO>(Math.max(0, end - start));
    for (let index = start; index < end; index += 1) {
      const record = this.ordered[index];
      if (record === undefined) throw new Error("Push index is inconsistent");
      pushes[index - start] = toDTO(record);
    }
    return {
      pushes,
      nextBefore:
        end < this.ordered.length && pushes.length > 0 ? (pushes.at(-1)?.id ?? null) : null,
    };
  }

  all(): readonly PushRecord[] {
    return this.ordered;
  }

  hasFile(id: string): boolean {
    return this.fileReferences.has(id);
  }

  fileSize(id: string): number | null {
    return this.fileReferences.get(id) ?? null;
  }

  get size(): number {
    return this.ordered.length;
  }

  async remove(id: string): Promise<boolean> {
    const record = this.byId.get(id);
    if (record === undefined) return false;
    const keys =
      record.file === null
        ? [pushObjectKey(record)]
        : [`files/${record.file.id}`, pushObjectKey(record)];
    await this.deps.storage.deleteMany(keys);
    this.byId.delete(id);
    const index = this.findIndex(record);
    this.ordered.splice(index, 1);
    if (record.file !== null) this.removeFileReference(record.file.id);
    this.deps.events.emit("push_deleted", { id });
    return true;
  }

  async reconcile(): Promise<void> {
    await this.mutex.run(async () => {
      const keys: PersistedPushKey[] = [];
      let inspected = 0;
      for await (const object of this.deps.storage.list(PUSH_PREFIX, {
        maxKeys: RECONCILIATION_KEY_LIMIT,
      })) {
        const persisted = parsePersistedKey(object.key);
        if (!this.byId.has(persisted.id)) keys.push(persisted);
        inspected += 1;
        if (inspected === RECONCILIATION_KEY_LIMIT) break;
      }
      const records = await loadPersistedRecords(this.deps.storage, keys);
      for (const record of records) this.add(record);
    });
  }

  private insertionIndex(record: PushRecord): number {
    let low = 0;
    let high = this.ordered.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const candidate = this.ordered[middle];
      if (candidate === undefined) throw new Error("Push index is inconsistent");
      if (comparePushes(candidate, record) < 0) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  private findIndex(record: PushRecord): number {
    let low = 0;
    let high = this.ordered.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const candidate = this.ordered[middle];
      if (candidate === undefined) break;
      const order = comparePushes(candidate, record);
      if (order === 0) return middle;
      if (order < 0) low = middle + 1;
      else high = middle - 1;
    }
    throw new Error("Push index is inconsistent");
  }

  private addFileReference(id: string, size: number): boolean {
    if (this.fileReferences.has(id)) return false;
    this.fileReferences.set(id, size);
    return true;
  }

  private removeFileReference(id: string): void {
    this.fileReferences.delete(id);
  }
}

export function startReconciliation({
  pushes,
  scheduler,
  logger,
}: ReconciliationDependencies): () => void {
  return scheduler.every(RECONCILIATION_INTERVAL_MS, async () => {
    try {
      await pushes.reconcile();
    } catch {
      logger.error("Push reconciliation failed");
    }
  });
}
