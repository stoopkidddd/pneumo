import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ZodType } from "zod";
import type { AppEnv } from "../app.js";

export function isJsonRequest(c: Context<AppEnv>): boolean {
  const mediaType = c.req.header("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || mediaType?.endsWith("+json") === true;
}

export async function readJsonValue(c: Context<AppEnv>): Promise<unknown> {
  if (!isJsonRequest(c)) throw new HTTPException(400);
  try {
    return await c.req.json();
  } catch {
    throw new HTTPException(400);
  }
}

export async function readJson<T>(c: Context<AppEnv>, schema: ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await readJsonValue(c));
  if (!parsed.success) throw new HTTPException(400);
  return parsed.data;
}
