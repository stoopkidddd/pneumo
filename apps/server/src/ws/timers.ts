export interface WebSocketTimers {
  after(ms: number, callback: () => void): () => void;
  every(ms: number, callback: () => void): () => void;
}

export const systemWebSocketTimers: WebSocketTimers = {
  after(ms, callback) {
    const timer = setTimeout(callback, ms);
    timer.unref();
    return () => clearTimeout(timer);
  },
  every(ms, callback) {
    const timer = setInterval(callback, ms);
    timer.unref();
    return () => clearInterval(timer);
  },
};
