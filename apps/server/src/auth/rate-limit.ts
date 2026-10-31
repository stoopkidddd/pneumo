import type { Clock } from "../app.js";

const WINDOW_MS = 15 * 60 * 1_000;

export class LoginRateLimiter {
  private readonly perIp = new Map<string, number[]>();
  private global: number[] = [];

  constructor(private readonly clock: Clock) {}

  retryAfter(ip: string): number | null {
    const now = this.clock.now();
    const cutoff = now - WINDOW_MS;
    this.global = this.global.filter((timestamp) => timestamp > cutoff);
    for (const [address, failures] of this.perIp) {
      const active = failures.filter((timestamp) => timestamp > cutoff);
      if (active.length === 0) this.perIp.delete(address);
      else this.perIp.set(address, active);
    }
    const local = this.perIp.get(ip) ?? [];
    let until = 0;
    if (local.length >= 5) until = (local[0] ?? now) + WINDOW_MS;
    if (this.global.length >= 30) until = Math.max(until, (this.global[0] ?? now) + WINDOW_MS);
    return until > now ? Math.ceil((until - now) / 1_000) : null;
  }

  failure(ip: string): void {
    const now = this.clock.now();
    const failures = this.perIp.get(ip) ?? [];
    failures.push(now);
    this.perIp.set(ip, failures);
    this.global.push(now);
  }

  success(ip: string): void {
    this.perIp.delete(ip);
  }
}
