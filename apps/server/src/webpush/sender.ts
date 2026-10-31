import type { PushDTO } from "@pneumo/protocol";
import type { Logger } from "pino";
import webPush from "web-push";
import type { Clock } from "../app.js";
import type { Config } from "../config.js";
import type { DeviceRegistry } from "../devices/registry.js";
import type { EventBus } from "../events.js";
import type { VapidKeys } from "./vapid.js";

const QUEUE_LIMIT = 1_000;
const CONCURRENCY = 4;
const SEND_TIMEOUT_MS = 10_000;
const DEDUPE_MS = 10 * 60_000;

interface SenderTimers {
  after(ms: number, callback: () => void): () => void;
}

const systemTimers: SenderTimers = {
  after(ms, callback) {
    const timer = setTimeout(callback, ms);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

interface SenderDependencies {
  devices: DeviceRegistry;
  events: EventBus;
  config: Pick<Config, "VAPID_SUBJECT">;
  vapidKeys: VapidKeys;
  clock: Clock;
  logger: Logger;
  timers?: SenderTimers;
}

interface Delivery {
  deviceId: string;
  payload: string;
}

function validSubject(subject: string): boolean {
  try {
    const url = new URL(subject);
    return url.protocol === "https:" || url.protocol === "mailto:";
  } catch {
    return false;
  }
}

function statusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return;
  const status = error.statusCode;
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
}

export function startWebPushSender(deps: SenderDependencies): () => void {
  const { devices, events, config, vapidKeys, clock, logger } = deps;
  const timers = deps.timers ?? systemTimers;
  const pending: Delivery[] = [];
  const seen = new Map<string, number>();
  const interrupts = new Set<() => void>();
  let workers = 0;
  let scheduled = false;
  let stopping = false;
  let warnedSubject = false;

  async function send(delivery: Delivery): Promise<void> {
    const subscription = devices.getWebPush(delivery.deviceId);
    if (subscription === null) return;
    // The stored subject may be from a previous deployment (or an HTTP dev origin).
    const subject = config.VAPID_SUBJECT;
    if (!validSubject(subject)) {
      if (!warnedSubject)
        logger.warn("Web Push disabled: VAPID_SUBJECT must use https: or mailto:");
      warnedSubject = true;
      return;
    }
    warnedSubject = false;

    const interrupted = Promise.withResolvers<void>();
    const cancelTimeout = timers.after(SEND_TIMEOUT_MS, interrupted.resolve);
    const interrupt = () => {
      cancelTimeout();
      interrupted.resolve();
    };
    interrupts.add(interrupt);
    try {
      // web-push also bounds socket inactivity; this deadline bounds the entire send.
      const result = await Promise.race([
        webPush
          .sendNotification(subscription, delivery.payload, {
            TTL: 86_400,
            urgency: "high",
            timeout: SEND_TIMEOUT_MS,
            vapidDetails: {
              subject,
              publicKey: vapidKeys.publicKey,
              privateKey: vapidKeys.privateKey,
            },
          })
          .then(() => "sent" as const),
        interrupted.promise.then(() => "interrupted" as const),
      ]);
      if (result === "interrupted" && !stopping) logger.warn("Web Push send timed out");
    } catch (error) {
      if (stopping) return;
      const status = statusCode(error);
      if (status === 404 || status === 410) {
        try {
          await devices.setWebPush(delivery.deviceId, null);
        } catch {
          logger.warn({ deviceId: delivery.deviceId }, "Web Push subscription cleanup failed");
        }
      } else {
        // Exceptions can contain the endpoint, keys and push-service response body.
        logger.warn({ deviceId: delivery.deviceId, statusCode: status }, "Web Push send failed");
      }
    } finally {
      cancelTimeout();
      interrupts.delete(interrupt);
    }
  }

  function schedule(): void {
    if (scheduled || stopping) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      while (!stopping && workers < CONCURRENCY && pending.length > 0) {
        const delivery = pending.shift();
        if (delivery === undefined) break;
        workers += 1;
        void send(delivery)
          .catch(() => logger.warn("Web Push delivery failed"))
          .finally(() => {
            workers -= 1;
            if (pending.length > 0) schedule();
          });
      }
    });
  }

  function receive({ push }: { push: PushDTO }): void {
    const now = clock.now();
    for (const [id, expires] of seen) {
      if (expires > now) break;
      seen.delete(id);
    }
    if (seen.has(push.id)) return;
    seen.set(push.id, now + DEDUPE_MS);

    const full = JSON.stringify({ t: "push", push });
    const payload =
      Buffer.byteLength(full, "utf8") <= 3_000 ? full : JSON.stringify({ t: "ref", id: push.id });
    for (const device of devices.list()) {
      if (
        device.platform !== "web" ||
        device.id === push.sourceDeviceId ||
        (push.targetDeviceId !== null && push.targetDeviceId !== device.id) ||
        devices.getWebPush(device.id) === null
      ) {
        continue;
      }
      if (pending.length === QUEUE_LIMIT) {
        pending.shift();
        logger.warn("Web Push queue full; dropped oldest delivery");
      }
      pending.push({ deviceId: device.id, payload });
    }
    if (pending.length > 0) schedule();
  }

  events.on("push", receive);
  return () => {
    stopping = true;
    events.off("push", receive);
    pending.length = 0;
    seen.clear();
    for (const interrupt of interrupts) interrupt();
    interrupts.clear();
  };
}
