import { createHash, randomBytes } from "node:crypto";
import {
  type DeviceDTO,
  DeviceInput,
  DeviceRecord,
  type SetupResponse,
  uuidv7,
  WebPushSubscription,
} from "@pneumo/protocol";
import type { Clock } from "../app.js";
import type { EventBus } from "../events.js";
import type { Storage } from "../storage/types.js";

const DEVICE_PREFIX = "devices/";
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;

interface DeviceRegistryDependencies {
  storage: Storage;
  clock: Clock;
  events: EventBus;
}

function objectKey(id: string): string {
  return `${DEVICE_PREFIX}${id}.json`;
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export class DeviceRegistry {
  private readonly records = new Map<string, DeviceRecord>();
  private readonly tokenIndex = new Map<string, string>();
  private readonly operations = new Map<string, Promise<void>>();
  private readonly online = new Set<string>();

  private constructor(private readonly deps: DeviceRegistryDependencies) {}

  static async load(deps: DeviceRegistryDependencies): Promise<DeviceRegistry> {
    const registry = new DeviceRegistry(deps);
    for await (const object of deps.storage.list(DEVICE_PREFIX)) {
      const match = /^devices\/([^/]+)\.json$/u.exec(object.key);
      if (match?.[1] === undefined) throw new Error("Invalid persisted device object key");

      const record = DeviceRecord.parse(await deps.storage.getJson<unknown>(object.key));
      if (record.id !== match[1] || registry.records.has(record.id)) {
        throw new Error("Invalid persisted device record");
      }
      if (registry.tokenIndex.has(record.tokenHash)) {
        throw new Error("Duplicate persisted device token hash");
      }
      registry.records.set(record.id, record);
      registry.tokenIndex.set(record.tokenHash, record.id);
    }
    return registry;
  }

  async create(input: DeviceInput): Promise<SetupResponse> {
    const device = DeviceInput.parse(input);
    let token = randomBytes(32).toString("base64url");
    let tokenHash = tokenDigest(token);
    while (this.tokenIndex.has(tokenHash)) {
      token = randomBytes(32).toString("base64url");
      tokenHash = tokenDigest(token);
    }
    const timestamp = new Date(this.deps.clock.now()).toISOString();
    let id = uuidv7();
    while (this.records.has(id)) id = uuidv7();

    const record = DeviceRecord.parse({
      v: 1,
      id,
      name: device.name,
      platform: device.platform,
      createdAt: timestamp,
      lastSeenAt: timestamp,
      tokenHash,
      webPush: null,
    });
    await this.deps.storage.putJson(objectKey(record.id), record);
    this.records.set(record.id, record);
    this.tokenIndex.set(record.tokenHash, record.id);

    const dto = this.toDTO(record);
    this.deps.events.emit("device_added", { device: dto });
    return { device: dto, token };
  }

  async authenticate(token: string): Promise<DeviceDTO | null> {
    const tokenHash = tokenDigest(token);
    const id = this.tokenIndex.get(tokenHash);
    if (id === undefined) return null;

    return this.serialized(id, async () => {
      const record = this.records.get(id);
      if (
        record === undefined ||
        record.tokenHash !== tokenHash ||
        this.tokenIndex.get(tokenHash) !== id
      ) {
        return null;
      }

      const now = this.deps.clock.now();
      const elapsed = now - Date.parse(record.lastSeenAt);
      if (elapsed < LAST_SEEN_WRITE_INTERVAL_MS) return this.toDTO(record);

      const updated = DeviceRecord.parse({
        ...record,
        lastSeenAt: new Date(now).toISOString(),
      });
      await this.deps.storage.putJson(objectKey(id), updated);
      this.records.set(id, updated);
      const dto = this.toDTO(updated);
      this.deps.events.emit("device_updated", { device: dto });
      return dto;
    });
  }

  get(id: string): DeviceDTO | null {
    const record = this.records.get(id);
    return record === undefined ? null : this.toDTO(record);
  }

  list(): DeviceDTO[] {
    return [...this.records.values()].map((record) => this.toDTO(record));
  }

  getWebPush(id: string): WebPushSubscription | null {
    return this.records.get(id)?.webPush ?? null;
  }

  setOnline(id: string, online: boolean): void {
    if (online && this.records.has(id)) {
      this.online.add(id);
    } else {
      this.online.delete(id);
    }
  }

  async rename(id: string, name: string): Promise<DeviceDTO | null> {
    return this.serialized(id, async () => {
      const record = this.records.get(id);
      if (record === undefined) return null;

      const updated = DeviceRecord.parse({ ...record, name });
      await this.deps.storage.putJson(objectKey(id), updated);
      this.records.set(id, updated);
      const dto = this.toDTO(updated);
      this.deps.events.emit("device_updated", { device: dto });
      return dto;
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.serialized(id, async () => {
      const record = this.records.get(id);
      if (record === undefined) return false;

      await this.deps.storage.delete(objectKey(id));
      this.records.delete(id);
      this.tokenIndex.delete(record.tokenHash);
      this.online.delete(id);
      this.deps.events.emit("device_removed", { id });
      this.deps.events.emit("close_device", { deviceId: id, code: 4401 });
      return true;
    });
  }

  async setWebPush(id: string, subscription: WebPushSubscription | null): Promise<boolean> {
    const parsed = subscription === null ? null : WebPushSubscription.parse(subscription);
    return this.serialized(id, async () => {
      const record = this.records.get(id);
      if (record === undefined) return false;

      const updated = DeviceRecord.parse({ ...record, webPush: parsed });
      await this.deps.storage.putJson(objectKey(id), updated);
      this.records.set(id, updated);
      return true;
    });
  }

  private toDTO(record: DeviceRecord): DeviceDTO {
    return {
      id: record.id,
      name: record.name,
      platform: record.platform,
      createdAt: record.createdAt,
      lastSeenAt: record.lastSeenAt,
      online: this.online.has(record.id),
    };
  }

  private async serialized<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(id) ?? Promise.resolve();
    const gate = Promise.withResolvers<void>();
    this.operations.set(id, gate.promise);
    await previous;
    try {
      return await operation();
    } finally {
      gate.resolve();
      if (this.operations.get(id) === gate.promise) this.operations.delete(id);
    }
  }
}
