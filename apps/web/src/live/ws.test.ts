// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type ConnectLiveOptions, type LiveConnection, connectLive as startLive } from "./ws.js";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = 0;
  readonly sent: string[] = [];
  readonly closes: Array<{ code: number; reason: string }> = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url: string | URL) {
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  receive(data: string) {
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  receiveJson(value: unknown) {
    this.receive(JSON.stringify(value));
  }

  serverClose(code: number) {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close", { code }));
  }

  send(data: string) {
    if (this.readyState !== 1) throw new Error("Socket is not open");
    this.sent.push(data);
  }

  close(code = 1000, reason = "") {
    this.readyState = 3;
    this.closes.push({ code, reason });
  }
}

const DEVICE_ID = "01900000-0000-7000-8000-000000000001";
const FIRST_CURSOR = "01900000-0000-7000-8000-000000000010";
const SECOND_CURSOR = "01900000-0000-7000-8000-000000000011";

const connections: LiveConnection[] = [];
function connectLive(options: ConnectLiveOptions) {
  const connection = startLive(options);
  connections.push(connection);
  return connection;
}

function callbacks(overrides: Partial<ConnectLiveOptions> = {}): ConnectLiveOptions {
  return {
    token: "fixed-fake-device-token",
    since: vi.fn(() => null),
    onFrame: vi.fn(),
    onResync: vi.fn(async () => undefined),
    onUnauthorized: vi.fn(),
    onStatus: vi.fn(),
    ...overrides,
  };
}

function latestSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) throw new Error("Expected a WebSocket instance");
  return socket;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});

afterEach(() => {
  for (const connection of connections) connection.stop();
  connections.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("connectLive", () => {
  test("connects to this origin, sends hello, answers ping, and becomes connected after replay", () => {
    const options = callbacks({ since: vi.fn(() => FIRST_CURSOR) });

    connectLive(options);
    const socket = latestSocket();
    expect(new URL(socket.url)).toMatchObject({ protocol: "ws:", pathname: "/api/ws" });
    expect(options.onStatus).toHaveBeenCalledWith("connecting");

    socket.open();
    expect(JSON.parse(socket.sent[0] ?? "")).toEqual({
      type: "hello",
      token: options.token,
      since: FIRST_CURSOR,
      client: { platform: "web", version: "0.1.0" },
    });
    expect(options.since).toHaveBeenCalledOnce();

    const ready = {
      type: "ready",
      deviceId: DEVICE_ID,
      serverTime: "2026-01-01T00:00:00.000Z",
    };
    socket.receiveJson(ready);
    expect(options.onFrame).toHaveBeenCalledWith(ready);
    expect(options.onStatus).not.toHaveBeenCalledWith("connected");

    socket.receiveJson({ type: "ping" });
    expect(JSON.parse(socket.sent[1] ?? "")).toEqual({ type: "pong" });
    expect(options.onFrame).toHaveBeenCalledTimes(1);

    socket.receiveJson({ type: "replay_done" });
    expect(options.onFrame).toHaveBeenLastCalledWith({ type: "replay_done" });
    expect(options.onStatus).toHaveBeenLastCalledWith("connected");
  });

  test("uses full-jitter reconnect steps and resets them after a stable minute", () => {
    connectLive(callbacks());
    const jitteredDelays = [500, 1_000, 2_500, 5_000, 15_000, 30_000, 30_000];

    for (const [index, delay] of jitteredDelays.entries()) {
      latestSocket().serverClose(1006);
      vi.advanceTimersByTime(delay - 1);
      expect(FakeWebSocket.instances).toHaveLength(index + 1);
      vi.advanceTimersByTime(1);
      expect(FakeWebSocket.instances).toHaveLength(index + 2);
    }

    latestSocket().open();
    vi.advanceTimersByTime(60_000);
    latestSocket().serverClose(1006);
    vi.advanceTimersByTime(499);
    expect(FakeWebSocket.instances).toHaveLength(jitteredDelays.length + 1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(jitteredDelays.length + 2);
  });

  test("retries a 1012 server restart after one to three seconds", () => {
    connectLive(callbacks());
    latestSocket().serverClose(1012);

    vi.advanceTimersByTime(1_999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  test("reconnects after 135 seconds without a server frame and resets silence on ping", () => {
    connectLive(callbacks());
    const socket = latestSocket();
    socket.open();

    vi.advanceTimersByTime(100_000);
    socket.receiveJson({ type: "ping" });
    vi.advanceTimersByTime(134_999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(socket.closes).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(socket.closes[0]?.code).toBe(4000);
    vi.advanceTimersByTime(499);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  test("waits for HTTP resync before reporting the connection synchronized", async () => {
    const resync = Promise.withResolvers<void>();
    const onResync = vi.fn(() => resync.promise);
    const options = callbacks({ onResync });
    connectLive(options);
    const socket = latestSocket();
    socket.open();

    socket.receiveJson({ type: "resync" });
    expect(onResync).toHaveBeenCalledOnce();
    expect(options.onFrame).not.toHaveBeenCalled();
    expect(options.onStatus).not.toHaveBeenCalledWith("connected");

    resync.resolve();
    await Promise.resolve();
    expect(options.onStatus).toHaveBeenLastCalledWith("connected");
  });

  test("captures the latest cursor in every hello and ignores stale socket events", () => {
    let cursor: string | null = FIRST_CURSOR;
    const options = callbacks({ since: vi.fn(() => cursor) });
    const connection = connectLive(options);
    const first = latestSocket();
    first.open();
    expect(JSON.parse(first.sent[0] ?? "").since).toBe(FIRST_CURSOR);

    cursor = SECOND_CURSOR;
    connection.reconnect();
    const second = latestSocket();
    expect(second).not.toBe(first);
    expect(first.closes[0]?.code).toBe(4000);
    second.open();
    expect(JSON.parse(second.sent[0] ?? "").since).toBe(SECOND_CURSOR);

    first.receiveJson({ type: "replay_done" });
    expect(options.onFrame).not.toHaveBeenCalled();
    expect(options.since).toHaveBeenCalledTimes(2);
  });

  test("treats 4401 as terminal and cannot be revived by browser events", () => {
    const options = callbacks();
    const connection = connectLive(options);
    latestSocket().serverClose(4401);

    expect(options.onUnauthorized).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(600_000);
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
    connection.reconnect();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  test("online and returning to a visible page reconnect immediately", () => {
    connectLive(callbacks());
    const first = latestSocket();
    window.dispatchEvent(new Event("online"));
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(first.closes[0]?.code).toBe(4000);

    const second = latestSocket();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(FakeWebSocket.instances).toHaveLength(3);
    expect(second.closes[0]?.code).toBe(4000);
  });

  test("rejects frames outside the frozen ServerFrame schema", () => {
    connectLive(callbacks());
    const socket = latestSocket();
    socket.open();
    socket.receiveJson({ type: "made_up" });

    expect(socket.closes[0]?.code).toBe(4000);
    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  test("stop closes the socket and removes every reconnect path", () => {
    const connection = connectLive(callbacks());
    const socket = latestSocket();
    socket.open();

    connection.stop();
    expect(socket.closes[0]?.code).toBe(1000);
    vi.advanceTimersByTime(600_000);
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
    socket.serverClose(1006);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  test("stop cancels a pending backoff timer", () => {
    const connection = connectLive(callbacks());
    latestSocket().serverClose(1006);

    connection.stop();
    vi.advanceTimersByTime(600_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
