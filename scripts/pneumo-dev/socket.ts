import { setTimeout as delay } from "node:timers/promises";
import { HelloFrame, ListPushesResponse, type PushDTO, ServerFrame } from "@pneumo/protocol";
import type { Client, DecryptedPush } from "./client.js";
import { SafeError } from "./errors.js";
import type { Session } from "./session.js";

type SocketEvent = { frame: ServerFrame } | { close: number };

export class Connection {
  private readonly socket: WebSocket;
  private readonly queue: SocketEvent[] = [];
  private wake: (() => void) | undefined;
  private failure: Error | undefined;
  private terminal: SocketEvent | undefined;
  private lastFrame = Date.now();
  private readonly watchdog: NodeJS.Timeout;
  private readonly onAbort: () => void;

  constructor(
    session: Session,
    since: string | null = null,
    private readonly signal?: AbortSignal,
    onPush: (push: PushDTO) => void = () => {},
  ) {
    const url = new URL("/api/ws", session.url);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    this.socket = new WebSocket(url);
    this.socket.addEventListener("open", () => {
      this.socket.send(
        JSON.stringify(
          HelloFrame.parse({
            type: "hello",
            token: session.token,
            since,
            client: { platform: "cli", version: "0.1.0" },
          }),
        ),
      );
    });
    this.socket.addEventListener("message", (event) => {
      try {
        const frame = ServerFrame.parse(JSON.parse(String(event.data)));
        this.lastFrame = Date.now();
        if (frame.type === "ping") {
          this.socket.send(JSON.stringify({ type: "pong" }));
          return;
        }
        if (frame.type === "ready" && frame.deviceId !== session.deviceId) {
          throw new SafeError("The socket authenticated as an unexpected device");
        }
        // Advance on receipt, not replay_done: a server backpressure close can interrupt replay.
        if (frame.type === "push") onPush(frame.push);
        this.queue.push({ frame });
        this.wake?.();
      } catch {
        this.fail(new SafeError("Invalid WebSocket frame"));
      }
    });
    this.socket.addEventListener("close", (event) => {
      this.terminal = { close: event.code };
      this.dispose();
      this.wake?.();
    });
    this.socket.addEventListener("error", () =>
      this.fail(new SafeError("WebSocket connection failed")),
    );
    this.onAbort = () => this.close();
    signal?.addEventListener("abort", this.onAbort, { once: true });
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastFrame > 135_000)
        this.fail(new SafeError("WebSocket heartbeat timed out"));
    }, 1_000);
    if (signal?.aborted) this.close();
  }

  private dispose(): void {
    clearInterval(this.watchdog);
    this.signal?.removeEventListener("abort", this.onAbort);
  }

  private fail(error: Error): void {
    this.failure = error;
    this.close();
  }

  close(): void {
    this.dispose();
    this.socket.close();
    this.terminal ??= { close: 1000 };
    this.wake?.();
  }

  async next(): Promise<SocketEvent> {
    for (;;) {
      const event = this.queue.shift();
      if (event) return event;
      if (this.failure) throw this.failure;
      if (this.terminal) return this.terminal;
      const pending = Promise.withResolvers<void>();
      this.wake = pending.resolve;
      await pending.promise;
      this.wake = undefined;
    }
  }

  async wait(predicate: (frame: ServerFrame) => boolean, timeout = 15_000): Promise<ServerFrame> {
    const timer = setTimeout(
      () => this.fail(new SafeError("Timed out waiting for a WebSocket event")),
      timeout,
    );
    try {
      for (;;) {
        const event = await this.next();
        if ("close" in event) throw new SafeError(`WebSocket closed (${event.close})`);
        if (predicate(event.frame)) return event.frame;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async waitForClose(timeout = 15_000): Promise<number> {
    const timer = setTimeout(
      () => this.fail(new SafeError("Timed out waiting for WebSocket close")),
      timeout,
    );
    try {
      for (;;) {
        const event = await this.next();
        if ("close" in event) return event.close;
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

async function resync(client: Client, seen: Set<string>): Promise<PushDTO[]> {
  const pushes: PushDTO[] = [];
  let before: string | null = null;
  for (;;) {
    const query = new URLSearchParams({ limit: "100" });
    if (before) query.set("before", before);
    const page = await client.api(`/api/pushes?${query}`, ListPushesResponse);
    let overlap = false;
    for (const push of page.pushes) {
      if (seen.has(push.id)) {
        overlap = true;
        break;
      }
      pushes.push(push);
    }
    if (overlap || !page.nextBefore) return pushes.reverse();
    before = page.nextBefore;
  }
}

export async function* pushes(client: Client, signal: AbortSignal): AsyncGenerator<DecryptedPush> {
  let cursor: string | null = null;
  const seen = new Set<string>();
  const backoff = [1, 2, 5, 10, 30, 60];
  let attempt = 0;
  while (!signal.aborted) {
    const connectedAt = Date.now();
    let closeCode: number | undefined;
    const connection = new Connection(client.session, cursor, signal, (push) => {
      cursor = push.id;
    });
    try {
      while (!signal.aborted) {
        const event = await connection.next();
        if ("close" in event) {
          closeCode = event.close;
          break;
        }
        const frame = event.frame;
        const received =
          frame.type === "push"
            ? [frame.push]
            : frame.type === "resync"
              ? await resync(client, seen)
              : [];
        for (const push of received) {
          if (seen.has(push.id)) continue;
          const decrypted = await client.decrypted(push);
          seen.add(push.id);
          yield decrypted;
        }
        if (frame.type === "resync" && received.length > 0) cursor = received.at(-1)?.id ?? cursor;
      }
    } catch (error) {
      if (error instanceof SafeError && error.message === "Invalid WebSocket frame") throw error;
      if (!signal.aborted && !(error instanceof SafeError)) throw error;
    } finally {
      connection.close();
    }
    if (signal.aborted) return;
    if (closeCode === 4401) throw new SafeError("Device unauthorized or revoked (4401)");
    if (closeCode === 4400) throw new SafeError("WebSocket protocol error (4400)");
    if (Date.now() - connectedAt >= 60_000) attempt = 0;
    const seconds =
      closeCode === 1012
        ? 1 + Math.random() * 2
        : Math.random() * (backoff[Math.min(attempt++, backoff.length - 1)] ?? 60);
    try {
      await delay(seconds * 1_000, undefined, { signal });
    } catch {
      return;
    }
  }
}
