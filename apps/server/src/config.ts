import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LevelWithSilent } from "pino";
import { z } from "zod";

const serverDirectory = fileURLToPath(new URL("..", import.meta.url));

const unsignedInteger = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));

const positiveInteger = unsignedInteger.pipe(z.number().positive());

const booleanString = z.enum(["true", "false"]).transform((value) => value === "true");

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}

const environmentSchema = z.object({
  PORT: unsignedInteger.pipe(z.number().max(65_535)).prefault("8080"),
  PUBLIC_URL: z.string().min(1).refine(isHttpOrigin),
  S3_ENDPOINT: z.string().min(1).refine(isHttpUrl),
  S3_REGION: z.string().min(1).default("auto"),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: booleanString.prefault("false"),
  S3_PREFIX: z.string().default(""),
  PNEUMO_SETUP_TOKEN: z.string().min(1).optional(),
  MAX_FILE_BYTES: positiveInteger.prefault("524288000"),
  MAX_ENVELOPE_BYTES: positiveInteger.prefault("65536"),
  RETENTION_DAYS: unsignedInteger.prefault("0"),
  UPLOAD_MODE: z.enum(["auto", "direct", "proxy"]).default("auto"),
  WS_PING_SECONDS: positiveInteger.prefault("60"),
  VAPID_SUBJECT: z.string().min(1).optional(),
  TRUST_PROXY: booleanString,
  WEB_DIST_DIR: z.string().min(1).default("../web/dist"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  RAILWAY_PUBLIC_DOMAIN: z.string().optional(),
  RAILWAY_ENVIRONMENT: z.string().optional(),
});

export type Config = {
  PORT: number;
  PUBLIC_URL: string;
  S3_ENDPOINT: string;
  S3_REGION: string;
  S3_BUCKET: string;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
  S3_FORCE_PATH_STYLE: boolean;
  S3_PREFIX: string;
  PNEUMO_SETUP_TOKEN?: string;
  MAX_FILE_BYTES: number;
  MAX_ENVELOPE_BYTES: number;
  RETENTION_DAYS: number;
  UPLOAD_MODE: "auto" | "direct" | "proxy";
  WS_PING_SECONDS: number;
  VAPID_SUBJECT: string;
  TRUST_PROXY: boolean;
  WEB_DIST_DIR: string;
  LOG_LEVEL: LevelWithSilent;
};

export class ConfigError extends Error {
  readonly variables: string[];

  constructor(variables: string[]) {
    const uniqueVariables = [...new Set(variables)];
    super(`Invalid environment variables: ${uniqueVariables.join(", ")}`);
    this.name = "ConfigError";
    this.variables = uniqueVariables;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const publicUrl =
    env.PUBLIC_URL ??
    (env.RAILWAY_PUBLIC_DOMAIN === undefined ? undefined : `https://${env.RAILWAY_PUBLIC_DOMAIN}`);
  const trustProxy = env.TRUST_PROXY ?? (env.RAILWAY_ENVIRONMENT === undefined ? "false" : "true");

  const result = environmentSchema.safeParse({
    ...env,
    PUBLIC_URL: publicUrl,
    TRUST_PROXY: trustProxy,
  });

  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => String(issue.path[0] ?? "ENVIRONMENT")),
    );
  }

  const parsed = result.data;
  return {
    PORT: parsed.PORT,
    PUBLIC_URL: parsed.PUBLIC_URL,
    S3_ENDPOINT: parsed.S3_ENDPOINT,
    S3_REGION: parsed.S3_REGION,
    S3_BUCKET: parsed.S3_BUCKET,
    S3_ACCESS_KEY_ID: parsed.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: parsed.S3_SECRET_ACCESS_KEY,
    S3_FORCE_PATH_STYLE: parsed.S3_FORCE_PATH_STYLE,
    S3_PREFIX: parsed.S3_PREFIX,
    ...(parsed.PNEUMO_SETUP_TOKEN === undefined
      ? {}
      : { PNEUMO_SETUP_TOKEN: parsed.PNEUMO_SETUP_TOKEN }),
    MAX_FILE_BYTES: parsed.MAX_FILE_BYTES,
    MAX_ENVELOPE_BYTES: parsed.MAX_ENVELOPE_BYTES,
    RETENTION_DAYS: parsed.RETENTION_DAYS,
    UPLOAD_MODE: parsed.UPLOAD_MODE,
    WS_PING_SECONDS: parsed.WS_PING_SECONDS,
    VAPID_SUBJECT: parsed.VAPID_SUBJECT ?? parsed.PUBLIC_URL,
    TRUST_PROXY: parsed.TRUST_PROXY,
    WEB_DIST_DIR: resolve(serverDirectory, parsed.WEB_DIST_DIR),
    LOG_LEVEL: parsed.LOG_LEVEL,
  };
}
