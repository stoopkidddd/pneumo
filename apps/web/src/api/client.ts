import { ERROR_STATUS, ErrorBody, type ErrorCode, routes } from "@pneumo/protocol";
import * as sessionStore from "../session/store.js";

type ProtocolRoute = (typeof routes)[number];
type HttpRoute = Exclude<ProtocolRoute, { readonly response: "websocket" }>;
export type HttpRouteName = HttpRoute["name"];

type RouteByName<Name extends HttpRouteName> = Extract<HttpRoute, { readonly name: Name }>;
type SchemaInput<Schema> = Schema extends {
  readonly _zod: { readonly input: infer Input };
}
  ? Input
  : never;
type SchemaOutput<Schema> = Schema extends { parse(value: unknown): infer Output } ? Output : never;

type PathParameterNames<Path extends string> =
  Path extends `${string}:${infer Parameter}/${infer Rest}`
    ? Parameter | PathParameterNames<`/${Rest}`>
    : Path extends `${string}:${infer Parameter}`
      ? Parameter
      : never;

export type BinaryBody = ArrayBuffer | ArrayBufferView<ArrayBuffer> | Blob;

type BodyOptions<Route extends HttpRoute> = Route extends { readonly request: infer Request }
  ? {
      body: Request extends "bytes" ? BinaryBody : SchemaInput<Request>;
    }
  : object;
type ParameterOptions<Route extends HttpRoute> = [PathParameterNames<Route["path"]>] extends [never]
  ? object
  : { params: Record<PathParameterNames<Route["path"]>, string> };
type QueryOptions<Route extends HttpRoute> = Route extends { readonly query: infer Query }
  ? { query?: SchemaInput<Query> }
  : object;

export type RequestOptions<Route extends HttpRoute> = {
  signal?: AbortSignal;
} & BodyOptions<Route> &
  ParameterOptions<Route> &
  QueryOptions<Route>;

type RequestArguments<Route extends HttpRoute> = Route extends { readonly request: unknown }
  ? [options: RequestOptions<Route>]
  : [PathParameterNames<Route["path"]>] extends [never]
    ? [options?: RequestOptions<Route>]
    : [options: RequestOptions<Route>];

type RouteResponse<Route extends HttpRoute> = Route["response"] extends null
  ? undefined
  : Route["response"] extends "bytes"
    ? Uint8Array<ArrayBuffer>
    : SchemaOutput<Route["response"]>;

export type ApiClient = {
  request<Name extends HttpRouteName>(
    name: Name,
    ...arguments_: RequestArguments<RouteByName<Name>>
  ): Promise<RouteResponse<RouteByName<Name>>>;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly retryAfterSeconds: number | null;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

type RuntimeOptions = {
  body?: unknown;
  params?: Record<string, string>;
  query?: unknown;
  signal?: AbortSignal;
};

const httpRoutes = new Map<HttpRouteName, HttpRoute>();
for (const route of routes) {
  if (route.response !== "websocket") httpRoutes.set(route.name, route);
}

function buildPath(route: HttpRoute, options: RuntimeOptions): string {
  let path = route.path.replace(/:([^/]+)/g, (_match, parameter: string) => {
    const value = options.params?.[parameter];
    if (value === undefined) throw new TypeError(`Missing path parameter: ${parameter}`);
    return encodeURIComponent(value);
  });

  if ("query" in route) {
    const values = route.query.parse(options.query ?? {}) as Record<string, unknown>;
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) query.set(key, String(value));
    }
    const serialized = query.toString();
    if (serialized) path += `?${serialized}`;
  }

  return path;
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) ? seconds : null;
  }

  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) return null;
  return Math.max(0, Math.ceil((timestamp - Date.now()) / 1_000));
}

async function parseErrorBody(response: Response) {
  try {
    const result = ErrorBody.safeParse(await response.json());
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function fallbackCode(route: HttpRoute, status: number): ErrorCode {
  let match: ErrorCode | null = null;
  for (const code of route.errors) {
    if (ERROR_STATUS[code] !== status) continue;
    if (match !== null) return "internal";
    match = code;
  }
  return match ?? "internal";
}

export function createApiClient({
  onUnauthorized,
}: {
  onUnauthorized: () => Promise<void>;
}): ApiClient {
  async function request<Name extends HttpRouteName>(
    name: Name,
    ...arguments_: RequestArguments<RouteByName<Name>>
  ): Promise<RouteResponse<RouteByName<Name>>> {
    const route = httpRoutes.get(name);
    if (!route) throw new TypeError(`Unknown HTTP route: ${name}`);

    const options = (arguments_[0] ?? {}) as RuntimeOptions;
    const headers = new Headers();
    let body: BodyInit | undefined;

    if ("request" in route) {
      if (route.request === "bytes") {
        body = options.body as BinaryBody;
        headers.set("Content-Type", "application/octet-stream");
      } else {
        body = JSON.stringify(route.request.parse(options.body));
        headers.set("Content-Type", "application/json");
      }
    }

    if (route.auth === "bearer") {
      const session = await sessionStore.load();
      if (!session) {
        await onUnauthorized();
        throw new ApiError(401, "unauthorized", "Unauthorized");
      }
      headers.set("Authorization", `Bearer ${session.token}`);
    }

    const requestInit: RequestInit = { method: route.method, headers };
    if (body !== undefined) requestInit.body = body;
    if (options.signal !== undefined) requestInit.signal = options.signal;
    const response = await fetch(buildPath(route, options), requestInit);

    if (!(route.success as readonly number[]).includes(response.status)) {
      const parsed = await parseErrorBody(response);
      const code =
        response.status === 401
          ? "unauthorized"
          : (parsed?.error.code ?? fallbackCode(route, response.status));
      const message = parsed?.error.message ?? `Request failed with HTTP ${response.status}`;
      const error = new ApiError(
        response.status,
        code,
        message,
        parseRetryAfter(response.headers.get("Retry-After")),
      );

      if (response.status === 401) {
        await sessionStore.clear();
        await onUnauthorized();
      }
      throw error;
    }

    if (route.response === null) return undefined as RouteResponse<RouteByName<Name>>;
    if (route.response === "bytes") {
      return new Uint8Array(await response.arrayBuffer()) as RouteResponse<RouteByName<Name>>;
    }
    return route.response.parse(await response.json()) as RouteResponse<RouteByName<Name>>;
  }

  return { request };
}
