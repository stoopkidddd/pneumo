import { EventEmitter } from "node:events";
import type { DeviceDTO, PushDTO } from "@pneumo/protocol";

export interface ServerEvents {
  push: { push: PushDTO };
  push_deleted: { id: string };
  device_added: { device: DeviceDTO };
  device_updated: { device: DeviceDTO };
  device_removed: { id: string };
  close_device: { deviceId: string; code: 4401 };
}

type EventName = keyof ServerEvents;
type EventListener<K extends EventName> = (payload: ServerEvents[K]) => void;

export class EventBus {
  private readonly emitter = new EventEmitter();

  on<K extends EventName>(event: K, listener: EventListener<K>): this {
    this.emitter.on(event, listener);
    return this;
  }

  off<K extends EventName>(event: K, listener: EventListener<K>): this {
    this.emitter.off(event, listener);
    return this;
  }

  emit<K extends EventName>(event: K, payload: ServerEvents[K]): boolean {
    return this.emitter.emit(event, payload);
  }
}
