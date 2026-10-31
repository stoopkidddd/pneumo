import { z } from "zod";
import { isUuidv7 } from "./helpers.js";

// RFC 4648 canonical, unpadded base64url, including zero trailing pad bits.
export const B64u = z.string().refine((value) => {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return false;
  const remainder = value.length % 4;
  if (remainder === 1) return false;
  if (remainder === 2) return /[AQgw]$/.test(value);
  if (remainder === 3) return /[AEIMQUYcgkosw048]$/.test(value);
  return true;
}, "Expected canonical unpadded base64url");
export type B64u = z.infer<typeof B64u>;

const encodedBytes = (bytes: number) =>
  B64u.refine(
    (value) => Math.floor((value.length * 3) / 4) === bytes,
    `Expected ${bytes} encoded bytes`,
  );
const byteCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveInteger = byteCount.min(1);
const credential = encodedBytes(32);
const pairCode = encodedBytes(16);

export const Uuidv7 = z.string().refine(isUuidv7, "Expected a lowercase canonical UUIDv7");
export type Uuidv7 = z.infer<typeof Uuidv7>;
export const IsoTimestamp = z.iso.datetime({ precision: 3 });
export type IsoTimestamp = z.infer<typeof IsoTimestamp>;
export const HttpUrl = z
  .string()
  .refine(
    (value) => !/\s/.test(value) && /^https?:\/\//i.test(value),
    "Expected an absolute HTTP(S) URL without whitespace",
  )
  .pipe(z.url({ protocol: /^https?$/, hostname: /.+/ }));
export type HttpUrl = z.infer<typeof HttpUrl>;

export const KdfParams = z.object({
  alg: z.literal("PBKDF2-SHA256"),
  iterations: positiveInteger,
  salt: encodedBytes(16),
});
export type KdfParams = z.infer<typeof KdfParams>;
export const Envelope = z.object({
  v: z.literal(1),
  n: encodedBytes(12),
  c: B64u.refine((value) => Math.floor((value.length * 3) / 4) >= 16, "Missing GCM tag"),
});
export type Envelope = z.infer<typeof Envelope>;

export const NotePayload = z.object({
  type: z.literal("note"),
  title: z.string().optional(),
  body: z.string(),
});
export type NotePayload = z.infer<typeof NotePayload>;
export const LinkPayload = z.object({
  type: z.literal("link"),
  title: z.string().optional(),
  body: z.string().optional(),
  url: HttpUrl,
});
export type LinkPayload = z.infer<typeof LinkPayload>;
export const FilePayload = z.object({
  type: z.literal("file"),
  title: z.string().optional(),
  body: z.string().optional(),
  file: z.object({ name: z.string(), mime: z.string(), size: byteCount, key: credential }),
});
export type FilePayload = z.infer<typeof FilePayload>;
export const PushPayload = z.discriminatedUnion("type", [NotePayload, LinkPayload, FilePayload]);
export type PushPayload = z.infer<typeof PushPayload>;

export const Platform = z.enum(["web", "android", "desktop", "cli"]);
export type Platform = z.infer<typeof Platform>;
export const WebPushSubscription = z.object({
  endpoint: HttpUrl,
  keys: z.object({ p256dh: encodedBytes(65), auth: encodedBytes(16) }),
});
export type WebPushSubscription = z.infer<typeof WebPushSubscription>;
export const DeviceInput = z.object({ name: z.string(), platform: Platform });
export type DeviceInput = z.infer<typeof DeviceInput>;
export const DeviceRecord = DeviceInput.extend({
  v: z.literal(1),
  id: Uuidv7,
  createdAt: IsoTimestamp,
  lastSeenAt: IsoTimestamp,
  tokenHash: credential,
  webPush: WebPushSubscription.nullable(),
});
export type DeviceRecord = z.infer<typeof DeviceRecord>;
export const DeviceDTO = DeviceRecord.omit({ v: true, tokenHash: true, webPush: true }).extend({
  online: z.boolean(),
});
export type DeviceDTO = z.infer<typeof DeviceDTO>;
export const PushRecord = z.object({
  v: z.literal(1),
  id: Uuidv7,
  createdAt: IsoTimestamp,
  sourceDeviceId: Uuidv7,
  targetDeviceId: Uuidv7.nullable(),
  envelope: Envelope,
  file: z.object({ id: Uuidv7, size: byteCount }).nullable(),
});
export type PushRecord = z.infer<typeof PushRecord>;
export const PushDTO = PushRecord.omit({ v: true });
export type PushDTO = z.infer<typeof PushDTO>;
export const Limits = z.object({ maxFileBytes: byteCount, maxEnvelopeBytes: byteCount });
export type Limits = z.infer<typeof Limits>;
export const UploadMode = z.enum(["auto", "direct", "proxy"]);
export type UploadMode = z.infer<typeof UploadMode>;
export const ErrorCode = z.enum([
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
export type ErrorCode = z.infer<typeof ErrorCode>;
export const ErrorBody = z.object({ error: z.object({ code: ErrorCode, message: z.string() }) });
export type ErrorBody = z.infer<typeof ErrorBody>;

export const HealthResponse = z.object({
  ok: z.literal(true),
  version: z.string(),
  initialized: z.boolean(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
export const SetupRequest = z.object({
  setupToken: z.string().min(1),
  kdf: KdfParams,
  authKey: credential,
  keyCheck: credential,
  device: DeviceInput,
});
export type SetupRequest = z.infer<typeof SetupRequest>;
export const SetupResponse = z.object({ device: DeviceDTO, token: credential });
export type SetupResponse = z.infer<typeof SetupResponse>;
export const AuthParamsResponse = z.object({ kdf: KdfParams });
export type AuthParamsResponse = z.infer<typeof AuthParamsResponse>;
export const LoginRequest = z.object({ authKey: credential, device: DeviceInput });
export type LoginRequest = z.infer<typeof LoginRequest>;
export const LoginResponse = SetupResponse;
export type LoginResponse = z.infer<typeof LoginResponse>;
export const MeResponse = z.object({
  device: DeviceDTO,
  keyCheck: credential,
  limits: Limits,
  vapidPublicKey: encodedBytes(65),
  uploadMode: UploadMode,
});
export type MeResponse = z.infer<typeof MeResponse>;
export const ListDevicesResponse = z.object({ devices: z.array(DeviceDTO) });
export type ListDevicesResponse = z.infer<typeof ListDevicesResponse>;
export const UpdateDeviceRequest = z.object({ name: z.string() });
export type UpdateDeviceRequest = z.infer<typeof UpdateDeviceRequest>;
export const SubscribeWebPushRequest = z.object({ subscription: WebPushSubscription });
export type SubscribeWebPushRequest = z.infer<typeof SubscribeWebPushRequest>;
export const CreatePairResponse = z.object({ code: pairCode, expiresAt: IsoTimestamp });
export type CreatePairResponse = z.infer<typeof CreatePairResponse>;
export const ClaimPairRequest = z.object({ code: pairCode, device: DeviceInput });
export type ClaimPairRequest = z.infer<typeof ClaimPairRequest>;
export const ClaimPairResponse = SetupResponse;
export type ClaimPairResponse = z.infer<typeof ClaimPairResponse>;
export const CreateFileRequest = z.object({ size: byteCount });
export type CreateFileRequest = z.infer<typeof CreateFileRequest>;
// Proxy URLs may be relative to the server; direct URLs are absolute.
const transferUrl = z.union([HttpUrl, z.string().regex(/^\/(?!\/)[^\s]*$/)]);
const headers = z.record(z.string(), z.string());
export const CreateFileResponse = z.object({
  fileId: Uuidv7,
  upload: z.object({ method: z.literal("PUT"), url: transferUrl, headers }),
  expiresAt: IsoTimestamp,
});
export type CreateFileResponse = z.infer<typeof CreateFileResponse>;
export const GetFileResponse = z.object({
  download: z.object({ url: transferUrl, headers }),
  expiresAt: IsoTimestamp,
});
export type GetFileResponse = z.infer<typeof GetFileResponse>;
export const CreatePushRequest = z.object({
  id: Uuidv7,
  targetDeviceId: Uuidv7.nullable(),
  envelope: Envelope,
  file: z.object({ id: Uuidv7 }).nullable(),
});
export type CreatePushRequest = z.infer<typeof CreatePushRequest>;
export const ListPushesQuery = z.object({
  before: Uuidv7.optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
export type ListPushesQuery = z.infer<typeof ListPushesQuery>;
export const ListPushesResponse = z.object({
  pushes: z.array(PushDTO),
  nextBefore: Uuidv7.nullable(),
});
export type ListPushesResponse = z.infer<typeof ListPushesResponse>;

export const HelloFrame = z.object({
  type: z.literal("hello"),
  token: credential,
  since: Uuidv7.nullable(),
  client: z.object({ platform: Platform, version: z.string() }),
});
export type HelloFrame = z.infer<typeof HelloFrame>;
export const PongFrame = z.object({ type: z.literal("pong") });
export type PongFrame = z.infer<typeof PongFrame>;
export const ClientFrame = z.discriminatedUnion("type", [HelloFrame, PongFrame]);
export type ClientFrame = z.infer<typeof ClientFrame>;
export const ReadyFrame = z.object({
  type: z.literal("ready"),
  deviceId: Uuidv7,
  serverTime: IsoTimestamp,
});
export type ReadyFrame = z.infer<typeof ReadyFrame>;
export const PushFrame = z.object({ type: z.literal("push"), push: PushDTO });
export type PushFrame = z.infer<typeof PushFrame>;
export const PushDeletedFrame = z.object({ type: z.literal("push_deleted"), id: Uuidv7 });
export type PushDeletedFrame = z.infer<typeof PushDeletedFrame>;
export const DeviceAddedFrame = z.object({ type: z.literal("device_added"), device: DeviceDTO });
export type DeviceAddedFrame = z.infer<typeof DeviceAddedFrame>;
export const DeviceUpdatedFrame = z.object({
  type: z.literal("device_updated"),
  device: DeviceDTO,
});
export type DeviceUpdatedFrame = z.infer<typeof DeviceUpdatedFrame>;
export const DeviceRemovedFrame = z.object({ type: z.literal("device_removed"), id: Uuidv7 });
export type DeviceRemovedFrame = z.infer<typeof DeviceRemovedFrame>;
export const ReplayDoneFrame = z.object({ type: z.literal("replay_done") });
export type ReplayDoneFrame = z.infer<typeof ReplayDoneFrame>;
export const ResyncFrame = z.object({ type: z.literal("resync") });
export type ResyncFrame = z.infer<typeof ResyncFrame>;
export const PingFrame = z.object({ type: z.literal("ping") });
export type PingFrame = z.infer<typeof PingFrame>;
export const ServerFrame = z.discriminatedUnion("type", [
  ReadyFrame,
  PushFrame,
  PushDeletedFrame,
  DeviceAddedFrame,
  DeviceUpdatedFrame,
  DeviceRemovedFrame,
  ReplayDoneFrame,
  ResyncFrame,
  PingFrame,
]);
export type ServerFrame = z.infer<typeof ServerFrame>;

export const jsonSchemas = {
  B64u,
  Uuidv7,
  IsoTimestamp,
  HttpUrl,
  KdfParams,
  Envelope,
  NotePayload,
  LinkPayload,
  FilePayload,
  PushPayload,
  Platform,
  WebPushSubscription,
  DeviceInput,
  DeviceRecord,
  DeviceDTO,
  PushRecord,
  PushDTO,
  Limits,
  UploadMode,
  ErrorCode,
  ErrorBody,
  HealthResponse,
  SetupRequest,
  SetupResponse,
  AuthParamsResponse,
  LoginRequest,
  LoginResponse,
  MeResponse,
  ListDevicesResponse,
  UpdateDeviceRequest,
  SubscribeWebPushRequest,
  CreatePairResponse,
  ClaimPairRequest,
  ClaimPairResponse,
  CreateFileRequest,
  CreateFileResponse,
  GetFileResponse,
  CreatePushRequest,
  ListPushesQuery,
  ListPushesResponse,
  HelloFrame,
  PongFrame,
  ClientFrame,
  ReadyFrame,
  PushFrame,
  PushDeletedFrame,
  DeviceAddedFrame,
  DeviceUpdatedFrame,
  DeviceRemovedFrame,
  ReplayDoneFrame,
  ResyncFrame,
  PingFrame,
  ServerFrame,
} as const;
