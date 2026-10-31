import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { ServerType } from "@hono/node-server";
import {
  ClientFrame,
  type HelloFrame,
  type ServerFrame,
  WS_HELLO_TIMEOUT_MS,
} from "@pneumo/protocol";
import type { Logger } from "pino";
import { WebSocket, WebSocketServer } from "ws";
import type { Clock } from "../app.js";
import type { DeviceRegistry } from "../devices/registry.js";
import type { EventBus, ServerEvents } from "../events.js";
import type { ShutdownHook } from "../http/shutdown.js";
import type { PushIndex } from "../index-store/index.js";
import { systemWebSocketTimers, type WebSocketTimers } from "./timers.js";

const MAX_BUFFERED_BYTES = 1_048_576;
const MAX_PAYLOAD_BYTES = 65_536;
const REPLAY_LIMIT = 200;
const PRESENCE_DEBOUNCE_MS = 2_000;

interface HubDependencies {
  server: ServerType;
  devices: DeviceRegistry;
  pushes: PushIndex;
  events: EventBus;
  clock: Clock;
  logger: Logger;
  pingSeconds: number;
  timers?: WebSocketTimers;
}

interface Session {
  deviceId: string | null;
  authenticating: boolean;
  missedPongs: number;
  cancelHello: () => void;
  cancelHeartbeat: () => void;
}

export function attachWebSocketHub(deps: HubDependencies): ShutdownHook {
  const { server, devices, pushes, events, clock, logger, pingSeconds } = deps;
  const timers = deps.timers ?? systemWebSocketTimers;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  const sessions = new Map<WebSocket, Session>();
  const counts = new Map<string, number>();
  const presenceTimers = new Map<string, () => void>();
  const unsubscribe: (() => void)[] = [];
  let stopping = false;
  let shutdown: Promise<void> | undefined;

  function updatePresence(id: string, delta: number): void {
    const previous = counts.get(id) ?? 0;
    const count = previous + delta;
    if (count === 0) counts.delete(id);
    else counts.set(id, count);
    if (previous > 0 === count > 0) return;
    devices.setOnline(id, count > 0);
    presenceTimers.get(id)?.();
    presenceTimers.delete(id);
    if (stopping || devices.get(id) === null) return;
    presenceTimers.set(
      id,
      timers.after(PRESENCE_DEBOUNCE_MS, () => {
        presenceTimers.delete(id);
        const device = devices.get(id);
        if (device !== null) events.emit("device_updated", { device });
      }),
    );
  }

  function send(socket: WebSocket, encoded: string): boolean {
    if (socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      socket.terminate();
      return false;
    }
    socket.send(encoded, (error) => {
      if (error) socket.terminate();
    });
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      socket.terminate();
      return false;
    }
    return true;
  }

  function sendFrame(socket: WebSocket, frame: ServerFrame): boolean {
    return send(socket, JSON.stringify(frame));
  }

  function broadcast(frame: ServerFrame): void {
    const encoded = JSON.stringify(frame);
    for (const [socket, session] of sessions) {
      if (session.deviceId !== null) send(socket, encoded);
    }
  }

  function subscribe<K extends keyof ServerEvents>(
    name: K,
    listener: (payload: ServerEvents[K]) => void,
  ): void {
    events.on(name, listener);
    unsubscribe.push(() => events.off(name, listener));
  }

  subscribe("push", (payload) => broadcast({ type: "push", ...payload }));
  subscribe("push_deleted", (payload) => broadcast({ type: "push_deleted", ...payload }));
  subscribe("device_added", (payload) => broadcast({ type: "device_added", ...payload }));
  subscribe("device_updated", (payload) => broadcast({ type: "device_updated", ...payload }));
  subscribe("device_removed", (payload) => {
    broadcast({ type: "device_removed", ...payload });
    presenceTimers.get(payload.id)?.();
    presenceTimers.delete(payload.id);
  });
  subscribe("close_device", ({ deviceId, code }) => {
    for (const [socket, session] of sessions) {
      if (session.deviceId === deviceId) socket.close(code);
    }
  });

  function replay(socket: WebSocket, since: string | null): void {
    if (since !== null) {
      // The index is newest first. Inspect only the replay window plus its cursor.
      const ordered = pushes.all();
      let cursor = 0;
      while (cursor <= REPLAY_LIMIT && cursor < ordered.length && ordered[cursor]?.id !== since) {
        cursor += 1;
      }
      if (cursor > REPLAY_LIMIT || cursor === ordered.length) {
        sendFrame(socket, { type: "resync" });
        return;
      }
      for (let index = cursor - 1; index >= 0; index -= 1) {
        const record = ordered[index];
        if (record === undefined) throw new Error("Push index is inconsistent");
        const { v: _version, ...push } = record;
        if (!sendFrame(socket, { type: "push", push })) return;
      }
    }
    sendFrame(socket, { type: "replay_done" });
  }

  async function authenticate(
    socket: WebSocket,
    session: Session,
    hello: HelloFrame,
  ): Promise<void> {
    try {
      const device = await devices.authenticate(hello.token);
      // Authentication can yield to revocation, shutdown, or disconnect.
      if (stopping || socket.readyState !== WebSocket.OPEN) return;
      if (device === null || devices.get(device.id) === null) {
        socket.close(4401);
        return;
      }
      session.deviceId = device.id;
      session.authenticating = false;
      updatePresence(device.id, 1);
      logger.info({ deviceId: device.id }, "WebSocket opened");
      if (
        !sendFrame(socket, {
          type: "ready",
          deviceId: device.id,
          serverTime: new Date(clock.now()).toISOString(),
        })
      )
        return;
      replay(socket, hello.since);
      session.cancelHeartbeat = timers.every(pingSeconds * 1_000, () => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (session.missedPongs >= 2) {
          socket.terminate();
          return;
        }
        if (sendFrame(socket, { type: "ping" })) session.missedPongs += 1;
      });
    } catch {
      // Never log an exception that might include the token or a frame.
      socket.terminate();
    }
  }

  wss.on("connection", (socket) => {
    const session: Session = {
      deviceId: null,
      authenticating: false,
      missedPongs: 0,
      cancelHello: timers.after(WS_HELLO_TIMEOUT_MS, () => socket.close(4401)),
      cancelHeartbeat: () => {},
    };
    sessions.set(socket, session);
    socket.on("error", () => socket.terminate());
    socket.on("close", (code) => {
      session.cancelHello();
      session.cancelHeartbeat();
      sessions.delete(socket);
      if (session.deviceId !== null) updatePresence(session.deviceId, -1);
      logger.info({ deviceId: session.deviceId, code }, "WebSocket closed");
    });
    socket.on("message", (data, isBinary) => {
      if (stopping || socket.readyState !== WebSocket.OPEN) return;
      if (isBinary) {
        socket.close(4400);
        return;
      }
      let frame: ClientFrame;
      try {
        frame = ClientFrame.parse(JSON.parse(data.toString()));
      } catch {
        socket.close(4400);
        return;
      }
      if (frame.type === "hello" && session.deviceId === null && !session.authenticating) {
        session.cancelHello();
        session.authenticating = true;
        void authenticate(socket, session, frame);
      } else if (frame.type === "pong" && (session.deviceId !== null || session.authenticating)) {
        session.missedPongs = 0;
      } else {
        socket.close(4400);
      }
    });
  });

  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Do not log URLs: tokens belong in hello, but an invalid client may put one in a query.
    if (stopping || request.url?.split("?", 1)[0] !== "/api/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (webSocket) => {
      wss.emit("connection", webSocket, request);
    });
  };
  server.on("upgrade", upgrade);

  return (code) => {
    if (shutdown !== undefined) return shutdown;
    stopping = true;
    for (const off of unsubscribe) off();
    for (const cancel of presenceTimers.values()) cancel();
    presenceTimers.clear();
    for (const [socket, session] of sessions) {
      session.cancelHello();
      session.cancelHeartbeat();
      socket.close(code);
    }
    const closed = Promise.withResolvers<void>();
    shutdown = closed.promise;
    wss.close(() => {
      server.off("upgrade", upgrade);
      closed.resolve();
    });
    return shutdown;
  };
}
