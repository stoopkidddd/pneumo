import { expect, test } from "vitest";
import { createLogger, createRequestLogger } from "./log.js";

const AUTHORIZATION = "Bearer x";
const LOWERCASE_AUTHORIZATION = "Bearer fixed-lowercase-authorization";
const TOKEN = "fixed-body-token";
const AUTH_KEY = "fixed-body-auth-key";
const SETUP_TOKEN = "fixed-setup-token";
const ENVELOPE_CIPHERTEXT = "fixed-envelope-ciphertext";
const P256DH = "fixed-web-push-p256dh";
const WEB_PUSH_AUTH = "fixed-web-push-auth";
const SUBSCRIPTION_AUTH = "fixed-subscription-auth";
const CHILD_TOKEN = "fixed-child-binding-token";
const PRESIGNED_SIGNATURE = "fixed-presigned-signature";
const REQUEST_QUERY_SECRET = "fixed-request-query-secret";
const ERROR_SECRET = "fixed-error-message-secret";

function captureLogs() {
  const lines: string[] = [];
  return {
    lines,
    destination: {
      write(message: string) {
        lines.push(message);
      },
    },
  };
}

test("redacts structured request secrets without changing caller data", () => {
  const { lines, destination } = captureLogs();
  const logger = createLogger("info", destination);
  const request = {
    headers: {
      Authorization: AUTHORIZATION,
      authorization: LOWERCASE_AUTHORIZATION,
    },
    url: `/api/pushes?token=${REQUEST_QUERY_SECRET}`,
    body: {
      token: TOKEN,
      authKey: AUTH_KEY,
      nested: {
        setupToken: SETUP_TOKEN,
        envelope: {
          ciphertext: ENVELOPE_CIPHERTEXT,
        },
      },
      webPush: {
        endpoint: "https://push.example.test/delivery",
        keys: {
          p256dh: P256DH,
          auth: WEB_PUSH_AUTH,
        },
      },
      subscription: {
        keys: {
          auth: SUBSCRIPTION_AUTH,
        },
      },
    },
    presignedUrl: `https://objects.example.test/uploads/file?X-Amz-Signature=${PRESIGNED_SIGNATURE}`,
  };

  logger.info({ request }, "received request");
  logger.child({ context: { token: CHILD_TOKEN } }).info({ event: "child binding check" });
  logger.error(new Error(`request failed with ${ERROR_SECRET}`));
  createRequestLogger(logger, "request-fixed-id").info({
    method: "POST",
    path: "/api/pushes",
    status: 201,
    ms: 12,
  });

  const captured = lines.join("");
  for (const secret of [
    AUTHORIZATION,
    LOWERCASE_AUTHORIZATION,
    TOKEN,
    AUTH_KEY,
    SETUP_TOKEN,
    ENVELOPE_CIPHERTEXT,
    P256DH,
    WEB_PUSH_AUTH,
    SUBSCRIPTION_AUTH,
    CHILD_TOKEN,
    PRESIGNED_SIGNATURE,
    REQUEST_QUERY_SECRET,
    ERROR_SECRET,
  ]) {
    expect(captured.includes(secret)).toBe(false);
  }
  expect(captured.includes("[Redacted]")).toBe(true);
  expect(captured.includes("https://objects.example.test/uploads/file")).toBe(true);
  expect(captured.includes("X-Amz-Signature")).toBe(false);

  expect(request.headers.Authorization === AUTHORIZATION).toBe(true);
  expect(request.body.token === TOKEN).toBe(true);
  expect(request.body.authKey === AUTH_KEY).toBe(true);
  expect(request.body.nested.setupToken === SETUP_TOKEN).toBe(true);
  expect(request.body.nested.envelope.ciphertext === ENVELOPE_CIPHERTEXT).toBe(true);
  expect(request.body.webPush.keys.p256dh === P256DH).toBe(true);
  expect(request.url.includes(REQUEST_QUERY_SECRET)).toBe(true);
  expect(request.presignedUrl.includes(PRESIGNED_SIGNATURE)).toBe(true);

  const requestLog = JSON.parse(lines.at(-1) ?? "null") as Record<string, unknown> | null;
  expect(requestLog?.requestId === "request-fixed-id").toBe(true);
  const requestFields = Object.keys(requestLog ?? {}).filter(
    (key) => key !== "level" && key !== "time" && key !== "pid" && key !== "hostname",
  );
  expect(requestFields.sort()).toEqual(["method", "ms", "path", "requestId", "status"]);
  expect("body" in (requestLog ?? {})).toBe(false);
});
