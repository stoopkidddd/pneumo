import { ServerFrame, type ServerFrame as ServerFrameValue } from "@pneumo/protocol";

export type LiveStatus = "connecting" | "connected" | "reconnecting";

export interface ConnectLiveOptions {
  token: string;
  since: () => string | null;
  onFrame: (frame: ServerFrameValue) => void;
  onResync: () => Promise<void>;
  onUnauthorized: () => void;
  onStatus: (status: LiveStatus) => void;
}

export interface LiveConnection {
  stop(): void;
  reconnect(): void;
}

const CLIENT_VERSION = "0.1.0";
const SILENCE_TIMEOUT_MS = 135_000;
const STABLE_CONNECTION_MS = 60_000;
const BACKOFF_SECONDS = [1, 2, 5, 10, 30, 60] as const;
const CLIENT_RECONNECT_CLOSE_CODE = 4000;

function socketUrl(): string {
  const url = new URL("/api/ws", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function connectLive(options: ConnectLiveOptions): LiveConnection {
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  let stableTimer: ReturnType<typeof setTimeout> | undefined;
  let retryStep = 0;
  let stopped = false;
  let listenersAttached = true;
  let synchronizedSocket: WebSocket | null = null;

  const clearTimer = (timer: ReturnType<typeof setTimeout> | undefined): undefined => {
    clearTimeout(timer);
    return undefined;
  };

  const clearConnectionTimers = () => {
    watchdogTimer = clearTimer(watchdogTimer);
    stableTimer = clearTimer(stableTimer);
  };

  const removeListeners = () => {
    if (!listenersAttached) return;
    listenersAttached = false;
    window.removeEventListener("online", reconnectNow);
    document.removeEventListener("visibilitychange", reconnectWhenVisible);
  };

  const isCurrent = (candidate: WebSocket): boolean => !stopped && socket === candidate;

  const armWatchdog = (candidate: WebSocket) => {
    watchdogTimer = clearTimer(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      if (!isCurrent(candidate)) return;
      socket = null;
      synchronizedSocket = null;
      clearConnectionTimers();
      candidate.close(CLIENT_RECONNECT_CLOSE_CODE, "Server silence timeout");
      scheduleReconnect();
    }, SILENCE_TIMEOUT_MS);
  };

  const markSynchronized = (candidate: WebSocket) => {
    if (!isCurrent(candidate) || synchronizedSocket === candidate) return;
    synchronizedSocket = candidate;
    options.onStatus("connected");
  };

  const failSocket = (candidate: WebSocket) => {
    if (!isCurrent(candidate)) return;
    socket = null;
    synchronizedSocket = null;
    clearConnectionTimers();
    candidate.close(CLIENT_RECONNECT_CLOSE_CODE, "Invalid server frame");
    scheduleReconnect();
  };

  const receiveFrame = (candidate: WebSocket, event: MessageEvent) => {
    if (!isCurrent(candidate)) return;
    armWatchdog(candidate);

    if (typeof event.data !== "string") {
      failSocket(candidate);
      return;
    }

    let rawFrame: unknown;
    try {
      rawFrame = JSON.parse(event.data);
    } catch {
      failSocket(candidate);
      return;
    }

    const parsed = ServerFrame.safeParse(rawFrame);
    if (!parsed.success) {
      failSocket(candidate);
      return;
    }

    const frame = parsed.data;
    if (frame.type === "ping") {
      try {
        candidate.send(JSON.stringify({ type: "pong" }));
      } catch {
        failSocket(candidate);
      }
      return;
    }

    if (frame.type === "resync") {
      try {
        void options.onResync().then(
          () => markSynchronized(candidate),
          () => failSocket(candidate),
        );
      } catch {
        failSocket(candidate);
      }
      return;
    }

    options.onFrame(frame);
    if (frame.type === "replay_done") markSynchronized(candidate);
  };

  const openSocket = () => {
    if (stopped) return;

    let candidate: WebSocket;
    try {
      candidate = new WebSocket(socketUrl());
    } catch {
      scheduleReconnect();
      return;
    }

    socket = candidate;
    synchronizedSocket = null;

    candidate.onopen = () => {
      if (!isCurrent(candidate)) return;
      try {
        candidate.send(
          JSON.stringify({
            type: "hello",
            token: options.token,
            since: options.since(),
            client: { platform: "web", version: CLIENT_VERSION },
          }),
        );
      } catch {
        failSocket(candidate);
        return;
      }

      armWatchdog(candidate);
      stableTimer = clearTimer(stableTimer);
      stableTimer = setTimeout(() => {
        if (isCurrent(candidate)) retryStep = 0;
      }, STABLE_CONNECTION_MS);
    };

    candidate.onmessage = (event) => receiveFrame(candidate, event);

    candidate.onclose = (event) => {
      if (!isCurrent(candidate)) return;
      socket = null;
      synchronizedSocket = null;
      clearConnectionTimers();

      if (event.code === 4401) {
        stopped = true;
        reconnectTimer = clearTimer(reconnectTimer);
        removeListeners();
        options.onUnauthorized();
        return;
      }

      scheduleReconnect(event.code);
    };
  };

  function scheduleReconnect(closeCode?: number) {
    if (stopped || reconnectTimer !== undefined) return;
    options.onStatus("reconnecting");

    let delayMs: number;
    if (closeCode === 1012) {
      delayMs = 1_000 + Math.random() * 2_000;
    } else {
      const seconds = BACKOFF_SECONDS[retryStep] ?? 60;
      delayMs = Math.random() * seconds * 1_000;
      retryStep = Math.min(retryStep + 1, BACKOFF_SECONDS.length - 1);
    }

    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      openSocket();
    }, delayMs);
  }

  function reconnectNow() {
    if (stopped) return;
    reconnectTimer = clearTimer(reconnectTimer);
    if (socket !== null) {
      const previous = socket;
      socket = null;
      synchronizedSocket = null;
      clearConnectionTimers();
      previous.close(CLIENT_RECONNECT_CLOSE_CODE, "Reconnect requested");
    }
    options.onStatus("reconnecting");
    openSocket();
  }

  function reconnectWhenVisible() {
    if (document.visibilityState === "visible") reconnectNow();
  }

  window.addEventListener("online", reconnectNow);
  document.addEventListener("visibilitychange", reconnectWhenVisible);
  options.onStatus("connecting");
  openSocket();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      reconnectTimer = clearTimer(reconnectTimer);
      clearConnectionTimers();
      removeListeners();
      if (socket !== null) {
        const previous = socket;
        socket = null;
        synchronizedSocket = null;
        previous.close(1000, "Client stopped");
      }
    },
    reconnect: reconnectNow,
  };
}
