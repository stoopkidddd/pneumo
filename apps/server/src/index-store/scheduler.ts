export interface Scheduler {
  every(ms: number, callback: () => Promise<void>): () => void;
}

export const systemScheduler: Scheduler = {
  every(ms, callback) {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      void Promise.resolve()
        .then(callback)
        .catch(() => undefined)
        .finally(() => {
          running = false;
        });
    }, ms);
    timer.unref();
    return () => clearInterval(timer);
  },
};
