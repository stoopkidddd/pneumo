import { describe, expect, expectTypeOf, test } from "vitest";
import { routes } from "./routes.js";
import {
  B64u,
  ClientFrame,
  CreateFileResponse,
  CreatePushRequest,
  DeviceDTO,
  DeviceRecord,
  Envelope,
  ErrorBody,
  ErrorCode,
  FilePayload,
  HttpUrl,
  IsoTimestamp,
  KdfParams,
  LinkPayload,
  ListPushesQuery,
  ListPushesResponse,
  type MeResponse,
  PushDTO,
  type PushPayload,
  PushRecord,
  ServerFrame,
  type SetupRequest,
  Uuidv7,
} from "./schemas.js";

const id = "019a33b0-4200-7000-8000-000000000001";
const time = "2026-10-30T12:00:00.000Z";
const envelope = { v: 1, n: "A".repeat(16), c: "A".repeat(22) } as const;
const device = {
  v: 1,
  id,
  name: "Pixel 9",
  platform: "android",
  createdAt: time,
  lastSeenAt: time,
  tokenHash: "A".repeat(43),
  webPush: null,
} as const;
const push = {
  v: 1,
  id,
  createdAt: time,
  sourceDeviceId: id,
  targetDeviceId: null,
  envelope,
  file: null,
} as const;

test("covers every normative HTTP route, including streaming and upgrade rows", () => {
  expect(routes.map(({ name, method, path }) => `${name} ${method} ${path}`)).toEqual([
    "health GET /api/health",
    "setup POST /api/setup",
    "authParams GET /api/auth/params",
    "login POST /api/auth/login",
    "me GET /api/me",
    "listDevices GET /api/devices",
    "updateDevice PATCH /api/devices/:id",
    "deleteDevice DELETE /api/devices/:id",
    "subscribeWebPush PUT /api/devices/self/webpush",
    "unsubscribeWebPush DELETE /api/devices/self/webpush",
    "createPair POST /api/pair",
    "claimPair POST /api/pair/claim",
    "createFile POST /api/files",
    "uploadFileContent PUT /api/files/:id/content",
    "getFile GET /api/files/:id",
    "downloadFileContent GET /api/files/:id/content",
    "createPush POST /api/pushes",
    "listPushes GET /api/pushes",
    "getPush GET /api/pushes/:id",
    "deletePush DELETE /api/pushes/:id",
    "ws GET /api/ws",
  ]);
});

test("covers every normative frame in the proper direction", () => {
  expect(ClientFrame.options.map((frame) => frame.shape.type.value)).toEqual(["hello", "pong"]);
  expect(ServerFrame.options.map((frame) => frame.shape.type.value)).toEqual([
    "ready",
    "push",
    "push_deleted",
    "device_added",
    "device_updated",
    "device_removed",
    "replay_done",
    "resync",
    "ping",
  ]);
  expect(ClientFrame.safeParse({ type: "ping" }).success).toBe(false);
  expect(ServerFrame.safeParse({ type: "pong" }).success).toBe(false);
});

describe("wire encoding", () => {
  test.each(["", "AA", "AAA", "AAAA", "__8", "_w", "SGVsbG8td29ybGQ"])(
    "accepts canonical base64url %s",
    (value) => expect(B64u.safeParse(value).success).toBe(true),
  );
  test.each(["A", "AB", "AAB", "AA=", "AA==", "+w", "/w", "AA\n", "é"])(
    "rejects noncanonical base64url %s",
    (value) => expect(B64u.safeParse(value).success).toBe(false),
  );
  test("enforces crypto byte lengths without Node encoders", () => {
    expect(Envelope.safeParse(envelope).success).toBe(true);
    expect(Envelope.safeParse({ ...envelope, n: "AA" }).success).toBe(false);
    expect(Envelope.safeParse({ ...envelope, c: "AA" }).success).toBe(false);
    expect(
      KdfParams.safeParse({ alg: "PBKDF2-SHA256", iterations: 1000, salt: "A".repeat(22) }).success,
    ).toBe(true);
    expect(
      KdfParams.safeParse({ alg: "PBKDF2-SHA256", iterations: 0, salt: "A".repeat(22) }).success,
    ).toBe(false);
  });
  test.each(["2026-10-30T12:00:00Z", "2026-10-30T12:00:00.000+01:00", "2026-02-30T12:00:00.000Z"])(
    "rejects noncanonical or impossible timestamps %s",
    (value) => expect(IsoTimestamp.safeParse(value).success).toBe(false),
  );
  test("keeps millisecond UTC timestamps", () => expect(IsoTimestamp.parse(time)).toBe(time));
  test("only accepts canonical UUIDv7", () => {
    expect(Uuidv7.safeParse(id).success).toBe(true);
    expect(Uuidv7.safeParse(id.toUpperCase()).success).toBe(false);
    expect(Uuidv7.safeParse(id.replace("7000", "4000")).success).toBe(false);
  });
});

test("DTO projection strips persisted credentials, subscription and version fields", () => {
  const parsed = DeviceDTO.parse({ ...device, online: true });
  expect(parsed).toEqual({
    id,
    name: "Pixel 9",
    platform: "android",
    createdAt: time,
    lastSeenAt: time,
    online: true,
  });
  expect(DeviceRecord.safeParse(device).success).toBe(true);
  expect(PushDTO.parse(push)).toEqual({
    id,
    createdAt: time,
    sourceDeviceId: id,
    targetDeviceId: null,
    envelope,
    file: null,
  });
  expect(PushRecord.safeParse(push).success).toBe(true);
});

test("request parsers strip unknown fields at nested boundaries", () => {
  const result = CreatePushRequest.parse({
    ...push,
    file: { id, size: 123, extra: true },
    envelope: { ...envelope, plaintext: "hidden" },
  });
  expect(result).toEqual({ id, targetDeviceId: null, envelope, file: { id } });
  expect(CreatePushRequest.safeParse({ id, envelope, file: null }).success).toBe(false);
  expect(CreatePushRequest.safeParse({ id, targetDeviceId: null, envelope }).success).toBe(false);
});

test("preserves explicit nulls for history and first WebSocket hello", () => {
  expect(ListPushesResponse.parse({ pushes: [], nextBefore: null })).toEqual({
    pushes: [],
    nextBefore: null,
  });
  expect(ListPushesResponse.safeParse({ pushes: [] }).success).toBe(false);
  const hello = {
    type: "hello",
    token: "A".repeat(43),
    since: null,
    client: { platform: "web", version: "0.1.0" },
  };
  expect(ClientFrame.safeParse(hello).success).toBe(true);
  expect(ClientFrame.safeParse({ ...hello, since: undefined }).success).toBe(false);
});

test("query defaults and boundaries do not coerce malformed values", () => {
  expect(ListPushesQuery.parse({})).toEqual({ limit: 50 });
  expect(ListPushesQuery.parse({ before: id, limit: 1 })).toEqual({ before: id, limit: 1 });
  expect(ListPushesQuery.parse({ limit: 100 })).toEqual({ limit: 100 });
  for (const limit of [0, 101, 1.5, "50", null]) {
    expect(ListPushesQuery.safeParse({ limit }).success).toBe(false);
  }
});

test("file byte sizes are nonnegative safe integers, not fixed to server defaults", () => {
  const file = {
    type: "file",
    file: { name: "empty.txt", mime: "text/plain", size: 0, key: "A".repeat(43) },
  };
  expect(FilePayload.safeParse(file).success).toBe(true);
  for (const size of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(FilePayload.safeParse({ ...file, file: { ...file.file, size } }).success).toBe(false);
  }
  expect(
    CreateFileResponse.safeParse({
      fileId: id,
      upload: { method: "PUT", url: "/api/files/fake/content", headers: {} },
      expiresAt: time,
    }).success,
  ).toBe(true);
});

test("link payloads require HTTP(S), without changing the supplied URL", () => {
  expect(LinkPayload.parse({ type: "link", url: "https://example.com/é" })).toEqual({
    type: "link",
    url: "https://example.com/é",
  });
  for (const url of [
    "ftp://example.com",
    "https://example.com text",
    " https://example.com",
    "/relative",
  ]) {
    expect(HttpUrl.safeParse(url).success).toBe(false);
  }
});

test("error bodies accept only the normative error codes", () => {
  expect(ErrorCode.options).toEqual([
    "bad_request",
    "unauthorized",
    "forbidden",
    "not_found",
    "conflict",
    "not_initialized",
    "gone",
    "payload_too_large",
    "rate_limited",
    "internal",
  ]);
  expect(ErrorBody.safeParse({ error: { code: "unexpected", message: "Failure" } }).success).toBe(
    false,
  );
});

test("DTOs and frame unions expose the normative TypeScript contract", () => {
  type ExpectedDevice = {
    id: string;
    name: string;
    platform: "web" | "android" | "desktop" | "cli";
    createdAt: string;
    lastSeenAt: string;
    online: boolean;
  };
  type ExpectedEnvelope = { v: 1; n: string; c: string };
  type ExpectedPush = {
    id: string;
    createdAt: string;
    sourceDeviceId: string;
    targetDeviceId: string | null;
    envelope: ExpectedEnvelope;
    file: { id: string; size: number } | null;
  };
  expectTypeOf<DeviceDTO>().toEqualTypeOf<ExpectedDevice>();
  expectTypeOf<PushDTO>().toEqualTypeOf<ExpectedPush>();
  expectTypeOf<DeviceRecord>().toEqualTypeOf<{
    id: string;
    name: string;
    platform: ExpectedDevice["platform"];
    createdAt: string;
    lastSeenAt: string;
    v: 1;
    tokenHash: string;
    webPush: { endpoint: string; keys: { p256dh: string; auth: string } } | null;
  }>();
  expectTypeOf<PushRecord>().toEqualTypeOf<{
    v: 1;
    id: string;
    createdAt: string;
    sourceDeviceId: string;
    targetDeviceId: string | null;
    envelope: ExpectedEnvelope;
    file: { id: string; size: number } | null;
  }>();
  expectTypeOf<PushPayload>().toEqualTypeOf<
    | { type: "note"; title?: string | undefined; body: string }
    | { type: "link"; title?: string | undefined; body?: string | undefined; url: string }
    | {
        type: "file";
        title?: string | undefined;
        body?: string | undefined;
        file: { name: string; mime: string; size: number; key: string };
      }
  >();
  expectTypeOf<ClientFrame>().toEqualTypeOf<
    | {
        type: "hello";
        token: string;
        since: string | null;
        client: { platform: ExpectedDevice["platform"]; version: string };
      }
    | { type: "pong" }
  >();
  expectTypeOf<ServerFrame>().toEqualTypeOf<
    | { type: "ready"; deviceId: string; serverTime: string }
    | { type: "push"; push: ExpectedPush }
    | { type: "push_deleted"; id: string }
    | { type: "device_added"; device: ExpectedDevice }
    | { type: "device_updated"; device: ExpectedDevice }
    | { type: "device_removed"; id: string }
    | { type: "replay_done" }
    | { type: "resync" }
    | { type: "ping" }
  >();
  expectTypeOf<SetupRequest["kdf"]>().toEqualTypeOf<KdfParams>();
  expectTypeOf<MeResponse["limits"]>().toEqualTypeOf<{
    maxFileBytes: number;
    maxEnvelopeBytes: number;
  }>();
});
