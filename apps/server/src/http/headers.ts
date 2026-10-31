import { basename } from "node:path";
import type { MiddlewareHandler } from "hono";

export function buildCsp(publicUrl: string, bucketOrigin?: string): string {
  const websocketOrigin = `wss://${new URL(publicUrl).host}`;
  const connectSources = ["'self'", websocketOrigin];
  if (bucketOrigin) connectSources.push(new URL(bucketOrigin).origin);
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src ${connectSources.join(" ")}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
}

export function securityHeaders(publicUrl: string, bucketOrigin?: string): MiddlewareHandler {
  const csp = buildCsp(publicUrl, bucketOrigin);
  const https = new URL(publicUrl).protocol === "https:";
  return async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (https) c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    if (c.res.headers.get("Content-Type")?.split(";", 1)[0] === "text/html") {
      c.header("Content-Security-Policy", csp);
    }
  };
}

export function staticCacheControl(path: string): string {
  const name = basename(path);
  if (
    name === "index.html" ||
    name === "sw.js" ||
    name === "manifest.json" ||
    name.endsWith(".webmanifest")
  ) {
    return "no-cache";
  }
  return /[.-][\w-]{8,}\.[\w.]+$/.test(name) ? "public, max-age=31536000, immutable" : "no-cache";
}
