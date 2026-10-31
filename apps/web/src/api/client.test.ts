import type { HealthResponse, SetupRequest } from "@pneumo/protocol";
import { beforeEach, expect, expectTypeOf, test, vi } from "vitest";
import { type ApiClient, ApiError, createApiClient } from "./client.js";

const sessionStore = vi.hoisted(() => ({
  load: vi.fn(),
  clear: vi.fn(),
}));

vi.mock("../session/store.js", () => sessionStore);

const persistedSession = {
  deviceId: "01900000-0000-7000-8000-000000000001",
  token: "fixed-fake-device-token",
  mk: new Uint8Array(32),
  contentKey: {} as CryptoKey,
};

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.clearAllMocks();
  sessionStore.load.mockResolvedValue(persistedSession);
  sessionStore.clear.mockResolvedValue(undefined);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

async function captureApiError(request: Promise<unknown>): Promise<ApiError> {
  try {
    await request;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error("Expected an ApiError");
}

test("maps protocol ErrorBody fields", async () => {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ error: { code: "not_found", message: "Push does not exist" } }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    }),
  );
  const client = createApiClient({ onUnauthorized: vi.fn() });

  const error = await captureApiError(client.request("getPush", { params: { id: "missing" } }));

  expect(error).toMatchObject({
    status: 404,
    code: "not_found",
    message: "Push does not exist",
    retryAfterSeconds: null,
  });
});

test("exposes Retry-After as seconds", async () => {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ error: { code: "rate_limited", message: "Slow down" } }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": "121" },
    }),
  );
  const client = createApiClient({ onUnauthorized: vi.fn() });

  const error = await captureApiError(client.request("health"));

  expect(error).toMatchObject({ code: "rate_limited", retryAfterSeconds: 121 });
});

test("clears a revoked session before notifying even when the 401 body is malformed", async () => {
  const calls: string[] = [];
  sessionStore.load.mockResolvedValueOnce(persistedSession).mockResolvedValue(null);
  sessionStore.clear.mockImplementation(async () => {
    calls.push("clear");
  });
  const onUnauthorized = vi.fn(async () => {
    calls.push("notify");
  });
  fetchMock.mockResolvedValue(new Response("malformed private response", { status: 401 }));
  const client = createApiClient({ onUnauthorized });

  const revoked = await captureApiError(client.request("me"));

  expect(revoked).toMatchObject({ status: 401, code: "unauthorized" });
  expect(revoked.message).toBe("Request failed with HTTP 401");
  expect(calls).toEqual(["clear", "notify"]);
  expect(sessionStore.clear).toHaveBeenCalledOnce();
  const sentHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
  expect(sentHeaders.get("Authorization")).toBe(`Bearer ${persistedSession.token}`);

  const missing = await captureApiError(client.request("me"));
  expect(missing).toMatchObject({ status: 401, code: "unauthorized" });
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(onUnauthorized).toHaveBeenCalledTimes(2);
});

function assertTypeContracts(client: ApiClient, setupBody: SetupRequest) {
  expectTypeOf(client.request("health")).toEqualTypeOf<Promise<HealthResponse>>();
  client.request("setup", { body: setupBody });
  client.request("me");
  client.request("listPushes", { query: { limit: "10" } });
  client.request("uploadFileContent", {
    params: { id: "file-id" },
    body: new Uint8Array([1, 2, 3]),
  });
  expectTypeOf(client.request("downloadFileContent", { params: { id: "file-id" } })).toEqualTypeOf<
    Promise<Uint8Array<ArrayBuffer>>
  >();
  expectTypeOf(client.request("deleteDevice", { params: { id: "device-id" } })).toEqualTypeOf<
    Promise<undefined>
  >();

  // @ts-expect-error WebSocket upgrades are not HTTP client routes.
  client.request("ws");
  // @ts-expect-error Path parameters are required.
  client.request("deleteDevice");
}

void assertTypeContracts;
