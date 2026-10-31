export class SafeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeError";
  }
}
