export class Mutex {
  private pending: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.pending;
    const { promise, resolve: release } = Promise.withResolvers<void>();
    this.pending = promise;
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
