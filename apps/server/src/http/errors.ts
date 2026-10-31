import { ERROR_STATUS, type ErrorBody, type ErrorCode } from "@pneumo/protocol";
import type { Context, ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../app.js";

const messages: Record<ErrorCode, string> = {
  bad_request: "Invalid request.",
  unauthorized: "Authentication required.",
  forbidden: "Access denied.",
  not_found: "Not found.",
  conflict: "Request conflicts with the current state.",
  not_initialized: "Instance is not initialized.",
  gone: "Resource is no longer available.",
  payload_too_large: "Request body is too large.",
  rate_limited: "Too many requests.",
  internal: "Internal server error.",
};

export function errorResponse(c: Context, code: ErrorCode) {
  const body: ErrorBody = { error: { code, message: messages[code] } };
  return c.json(body, ERROR_STATUS[code]);
}

export const handleError: ErrorHandler<AppEnv> = (error, c) => {
  let code: ErrorCode = "internal";
  if (error instanceof HTTPException) {
    code =
      (Object.keys(ERROR_STATUS) as ErrorCode[]).find(
        (candidate) => ERROR_STATUS[candidate] === error.status,
      ) ?? "internal";
  }
  if (code === "internal") c.get("logger")?.error("Request failed");
  return errorResponse(c, code);
};
