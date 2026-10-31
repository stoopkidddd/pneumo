import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { ConfigError, loadConfig } from "./config.js";

const serverDirectory = fileURLToPath(new URL("..", import.meta.url));

function requiredEnvironment(): NodeJS.ProcessEnv {
  return {
    PUBLIC_URL: "https://pneumo.example",
    S3_ENDPOINT: "https://objects.example",
    S3_BUCKET: "pneumo",
    S3_ACCESS_KEY_ID: "access-key",
    S3_SECRET_ACCESS_KEY: "secret-key",
  };
}

function getConfigError(env: NodeJS.ProcessEnv): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }

  throw new Error("Expected loadConfig to throw ConfigError");
}

test("loads all defaults and converts environment strings", () => {
  const config = loadConfig(requiredEnvironment());

  expect(config).toEqual({
    PORT: 8080,
    PUBLIC_URL: "https://pneumo.example",
    S3_ENDPOINT: "https://objects.example",
    S3_REGION: "auto",
    S3_BUCKET: "pneumo",
    S3_ACCESS_KEY_ID: "access-key",
    S3_SECRET_ACCESS_KEY: "secret-key",
    S3_FORCE_PATH_STYLE: false,
    S3_PREFIX: "",
    MAX_FILE_BYTES: 524_288_000,
    MAX_ENVELOPE_BYTES: 65_536,
    RETENTION_DAYS: 0,
    UPLOAD_MODE: "auto",
    WS_PING_SECONDS: 60,
    VAPID_SUBJECT: "https://pneumo.example",
    TRUST_PROXY: false,
    WEB_DIST_DIR: resolve(serverDirectory, "../web/dist"),
    LOG_LEVEL: "info",
  });
  expect(config).not.toHaveProperty("PNEUMO_SETUP_TOKEN");
});

test("loads every explicit setting", () => {
  const config = loadConfig({
    ...requiredEnvironment(),
    PORT: "3000",
    PUBLIC_URL: "http://localhost:3000",
    S3_ENDPOINT: "http://localhost:9000/storage",
    S3_REGION: "us-east-1",
    S3_FORCE_PATH_STYLE: "false",
    S3_PREFIX: "shared/",
    PNEUMO_SETUP_TOKEN: "setup-token",
    MAX_FILE_BYTES: "1000",
    MAX_ENVELOPE_BYTES: "100",
    RETENTION_DAYS: "30",
    UPLOAD_MODE: "proxy",
    WS_PING_SECONDS: "15",
    VAPID_SUBJECT: "mailto:admin@example.test",
    TRUST_PROXY: "false",
    WEB_DIST_DIR: "/srv/pneumo/web",
    LOG_LEVEL: "silent",
  });

  expect(config).toEqual({
    PORT: 3000,
    PUBLIC_URL: "http://localhost:3000",
    S3_ENDPOINT: "http://localhost:9000/storage",
    S3_REGION: "us-east-1",
    S3_BUCKET: "pneumo",
    S3_ACCESS_KEY_ID: "access-key",
    S3_SECRET_ACCESS_KEY: "secret-key",
    S3_FORCE_PATH_STYLE: false,
    S3_PREFIX: "shared/",
    PNEUMO_SETUP_TOKEN: "setup-token",
    MAX_FILE_BYTES: 1000,
    MAX_ENVELOPE_BYTES: 100,
    RETENTION_DAYS: 30,
    UPLOAD_MODE: "proxy",
    WS_PING_SECONDS: 15,
    VAPID_SUBJECT: "mailto:admin@example.test",
    TRUST_PROXY: false,
    WEB_DIST_DIR: "/srv/pneumo/web",
    LOG_LEVEL: "silent",
  });
});

const requiredVariables = [
  "PUBLIC_URL",
  "S3_ENDPOINT",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
] as const;

test.each(requiredVariables)("rejects missing required variable %s", (variable) => {
  const env = requiredEnvironment();
  delete env[variable];

  const error = getConfigError(env);

  expect(error.variables).toEqual([variable]);
  expect(error.message).toBe(`Invalid environment variables: ${variable}`);
});

test("aggregates variable names without exposing values or zod diagnostics", () => {
  const leakedEndpoint = "not-a-url-containing-a-secret";
  const leakedAccessKey = 123_456;
  const leakedSecret = { value: "do-not-print-this-secret" };
  const env = {
    ...requiredEnvironment(),
    PUBLIC_URL: "https://pneumo.example/",
    S3_ENDPOINT: leakedEndpoint,
    S3_BUCKET: "",
    S3_ACCESS_KEY_ID: leakedAccessKey,
    S3_SECRET_ACCESS_KEY: leakedSecret,
  } as unknown as NodeJS.ProcessEnv;

  const error = getConfigError(env);

  expect(error.variables).toEqual([
    "PUBLIC_URL",
    "S3_ENDPOINT",
    "S3_BUCKET",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
  ]);
  expect(error.message).toBe(
    "Invalid environment variables: PUBLIC_URL, S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY",
  );
  expect(error.message).not.toContain(leakedEndpoint);
  expect(error.message).not.toContain(String(leakedAccessKey));
  expect(error.message).not.toContain(leakedSecret.value);
  expect(error.message).not.toContain("Invalid input");
});

test.each([
  ["PORT", "65536"],
  ["MAX_FILE_BYTES", "1.5"],
  ["MAX_ENVELOPE_BYTES", "-1"],
  ["RETENTION_DAYS", "-1"],
  ["WS_PING_SECONDS", "NaN"],
  ["WS_PING_SECONDS", "9007199254740992"],
] as const)("rejects invalid integer %s=%s", (variable, value) => {
  const error = getConfigError({ ...requiredEnvironment(), [variable]: value });

  expect(error.variables).toEqual([variable]);
});

test("accepts port zero for an ephemeral server port", () => {
  expect(loadConfig({ ...requiredEnvironment(), PORT: "0" }).PORT).toBe(0);
});

test("parses true and false boolean strings without truthy coercion", () => {
  const falseConfig = loadConfig({
    ...requiredEnvironment(),
    S3_FORCE_PATH_STYLE: "false",
    TRUST_PROXY: "false",
    RAILWAY_ENVIRONMENT: "production",
  });
  const trueConfig = loadConfig({
    ...requiredEnvironment(),
    S3_FORCE_PATH_STYLE: "true",
    TRUST_PROXY: "true",
  });

  expect(falseConfig.S3_FORCE_PATH_STYLE).toBe(false);
  expect(falseConfig.TRUST_PROXY).toBe(false);
  expect(trueConfig.S3_FORCE_PATH_STYLE).toBe(true);
  expect(trueConfig.TRUST_PROXY).toBe(true);
});

test("accepts only exact true and false boolean strings", () => {
  const error = getConfigError({
    ...requiredEnvironment(),
    S3_FORCE_PATH_STYLE: "FALSE",
    TRUST_PROXY: "0",
  });

  expect(error.variables).toEqual(["S3_FORCE_PATH_STYLE", "TRUST_PROXY"]);
});

test("uses the Railway public domain fallback", () => {
  const env = requiredEnvironment();
  delete env.PUBLIC_URL;
  env.RAILWAY_PUBLIC_DOMAIN = "pneumo-production.up.railway.app";

  const config = loadConfig(env);

  expect(config.PUBLIC_URL).toBe("https://pneumo-production.up.railway.app");
  expect(config.VAPID_SUBJECT).toBe(config.PUBLIC_URL);
  expect(config).not.toHaveProperty("RAILWAY_PUBLIC_DOMAIN");
});

test("prefers an explicit public URL over the Railway fallback", () => {
  const config = loadConfig({
    ...requiredEnvironment(),
    PUBLIC_URL: "https://custom.example",
    RAILWAY_PUBLIC_DOMAIN: "pneumo-production.up.railway.app",
  });

  expect(config.PUBLIC_URL).toBe("https://custom.example");
});

test("defaults trust proxy from Railway and permits an explicit override", () => {
  expect(
    loadConfig({ ...requiredEnvironment(), RAILWAY_ENVIRONMENT: "production" }).TRUST_PROXY,
  ).toBe(true);
  expect(
    loadConfig({
      ...requiredEnvironment(),
      RAILWAY_ENVIRONMENT: "production",
      TRUST_PROXY: "false",
    }).TRUST_PROXY,
  ).toBe(false);
});

test("resolves the web directory relative to apps/server, not the current directory", () => {
  const originalDirectory = process.cwd();
  process.chdir(tmpdir());

  try {
    expect(loadConfig(requiredEnvironment()).WEB_DIST_DIR).toBe(
      resolve(serverDirectory, "../web/dist"),
    );
    expect(
      loadConfig({ ...requiredEnvironment(), WEB_DIST_DIR: "fixtures/web" }).WEB_DIST_DIR,
    ).toBe(resolve(serverDirectory, "fixtures/web"));
  } finally {
    process.chdir(originalDirectory);
  }
});

test.each(["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const)(
  "accepts pino log level %s",
  (level) => {
    expect(loadConfig({ ...requiredEnvironment(), LOG_LEVEL: level }).LOG_LEVEL).toBe(level);
  },
);

test("rejects non-HTTP URLs, non-origin public URLs, and unknown upload modes", () => {
  const error = getConfigError({
    ...requiredEnvironment(),
    PUBLIC_URL: "https://pneumo.example/path",
    S3_ENDPOINT: "ftp://objects.example",
    UPLOAD_MODE: "automatic",
  });

  expect(error.variables).toEqual(["PUBLIC_URL", "S3_ENDPOINT", "UPLOAD_MODE"]);
});
