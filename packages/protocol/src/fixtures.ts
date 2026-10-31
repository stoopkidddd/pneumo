import type { jsonSchemas } from "./schemas.js";

type JsonSchemaName = keyof typeof jsonSchemas;

type FixtureExpectation = "valid" | "invalid";

export interface FixtureCase {
  readonly schemaName: JsonSchemaName;
  readonly path: string;
  readonly expectation: FixtureExpectation;
  readonly value: unknown;
}

interface SchemaFixtureDefinition {
  readonly valid: Readonly<Record<string, unknown>>;
  readonly invalid: Readonly<Record<string, unknown>>;
}

const B64_12 = "A".repeat(16);
const B64_16 = "A".repeat(22);
const B64_32 = "A".repeat(43);
const B64_65 = "A".repeat(87);

const DEVICE_ID = "019a36f0-7b00-7000-8000-000000000001";
const SECOND_DEVICE_ID = "019a36f0-7b00-7000-8000-000000000002";
const PUSH_ID = "019a36f0-7b00-7000-8000-000000000003";
const SECOND_PUSH_ID = "019a36f0-7b00-7000-8000-000000000004";
const FILE_ID = "019a36f0-7b00-7000-8000-000000000005";
const CREATED_AT = "2026-10-30T12:00:00.000Z";
const LAST_SEEN_AT = "2026-10-30T12:05:00.000Z";
const EXPIRES_AT = "2026-10-30T13:00:00.000Z";

const kdf = {
  alg: "PBKDF2-SHA256",
  iterations: 600_000,
  salt: B64_16,
};

const envelope = {
  v: 1,
  n: B64_12,
  c: B64_16,
};

const webPush = {
  endpoint: "https://push.example.test/subscriptions/fake-device",
  keys: {
    p256dh: B64_65,
    auth: B64_16,
  },
};

const deviceInput = {
  name: "Pixel 9",
  platform: "android",
};

const deviceRecord = {
  v: 1,
  id: DEVICE_ID,
  name: "Pixel 9",
  platform: "android",
  createdAt: CREATED_AT,
  lastSeenAt: LAST_SEEN_AT,
  tokenHash: B64_32,
  webPush: null,
};

const deviceDto = {
  id: DEVICE_ID,
  name: "Pixel 9",
  platform: "android",
  createdAt: CREATED_AT,
  lastSeenAt: LAST_SEEN_AT,
  online: true,
};

const fileReference = {
  id: FILE_ID,
  size: 65_560,
};

const pushRecord = {
  v: 1,
  id: PUSH_ID,
  createdAt: CREATED_AT,
  sourceDeviceId: DEVICE_ID,
  targetDeviceId: null,
  envelope,
  file: null,
};

const pushDto = {
  id: PUSH_ID,
  createdAt: CREATED_AT,
  sourceDeviceId: DEVICE_ID,
  targetDeviceId: null,
  envelope,
  file: null,
};

const limits = {
  maxFileBytes: 524_288_000,
  maxEnvelopeBytes: 65_536,
};

const fixtureDefinitions = {
  B64u: {
    valid: { default: B64_16, empty: "" },
    invalid: { "padding-forbidden": "YQ==", "alphabet-forbidden": "a+b/c" },
  },
  Uuidv7: {
    valid: { default: PUSH_ID },
    invalid: {
      "wrong-version": "019a36f0-7b00-4000-8000-000000000003",
      "uppercase-forbidden": "019A36F0-7B00-7000-8000-000000000003",
    },
  },
  IsoTimestamp: {
    valid: { default: CREATED_AT },
    invalid: {
      "milliseconds-required": "2026-10-30T12:00:00Z",
      "utc-required": "2026-10-30T12:00:00.000+01:00",
    },
  },
  HttpUrl: {
    valid: { default: "https://pneumo.example.test/path?q=fake" },
    invalid: {
      "http-scheme-required": "ftp://pneumo.example.test/file",
      "absolute-url-required": "/relative/path",
    },
  },
  KdfParams: {
    valid: { default: kdf },
    invalid: {
      "salt-must-be-16-bytes": { ...kdf, salt: B64_12 },
      "iterations-must-be-positive": { ...kdf, iterations: 0 },
    },
  },
  Envelope: {
    valid: { default: envelope },
    invalid: {
      "nonce-must-be-12-bytes": { ...envelope, n: B64_16 },
      "ciphertext-includes-tag": { ...envelope, c: B64_12 },
    },
  },
  NotePayload: {
    valid: {
      default: { type: "note", body: "Remember the train tickets." },
      titled: { type: "note", title: "Travel", body: "Remember the train tickets." },
    },
    invalid: {
      "body-required": { type: "note" },
      "wrong-discriminator": { type: "link", body: "Not a note" },
    },
  },
  LinkPayload: {
    valid: {
      default: { type: "link", url: "https://example.test/article" },
      described: {
        type: "link",
        title: "Reading list",
        body: "Read this later.",
        url: "https://example.test/article",
      },
    },
    invalid: {
      "url-must-be-http": { type: "link", url: "mailto:fake@example.test" },
      "wrong-discriminator": { type: "note", url: "https://example.test/article" },
    },
  },
  FilePayload: {
    valid: {
      default: {
        type: "file",
        file: { name: "report.pdf", mime: "application/pdf", size: 65_536, key: B64_32 },
      },
      captioned: {
        type: "file",
        title: "Quarterly report",
        body: "For review.",
        file: { name: "report.pdf", mime: "application/pdf", size: 65_536, key: B64_32 },
      },
    },
    invalid: {
      "file-key-must-be-32-bytes": {
        type: "file",
        file: { name: "report.pdf", mime: "application/pdf", size: 65_536, key: B64_16 },
      },
      "file-size-must-be-nonnegative": {
        type: "file",
        file: { name: "report.pdf", mime: "application/pdf", size: -1, key: B64_32 },
      },
    },
  },
  PushPayload: {
    valid: {
      note: { type: "note", body: "Remember the train tickets." },
      link: { type: "link", url: "https://example.test/article" },
      file: {
        type: "file",
        body: "For review.",
        file: { name: "report.pdf", mime: "application/pdf", size: 65_536, key: B64_32 },
      },
    },
    invalid: {
      "known-type-required": { type: "video", body: "Unsupported" },
      "discriminator-required": { body: "Missing type" },
    },
  },
  Platform: {
    valid: {
      web: "web",
      android: "android",
      desktop: "desktop",
      cli: "cli",
    },
    invalid: { "known-platform-required": "ios", "string-required": 1 },
  },
  WebPushSubscription: {
    valid: { default: webPush },
    invalid: {
      "endpoint-must-be-http": { ...webPush, endpoint: "mailto:fake@example.test" },
      "p256dh-must-be-65-bytes": {
        ...webPush,
        keys: { ...webPush.keys, p256dh: B64_32 },
      },
    },
  },
  DeviceInput: {
    valid: { default: deviceInput },
    invalid: {
      "name-required": { platform: "android" },
      "known-platform-required": { name: "Phone", platform: "ios" },
    },
  },
  DeviceRecord: {
    valid: {
      "without-webpush": deviceRecord,
      "with-webpush": { ...deviceRecord, platform: "web", webPush },
    },
    invalid: {
      "token-hash-must-be-32-bytes": { ...deviceRecord, tokenHash: B64_16 },
      "webpush-must-be-object-or-null": { ...deviceRecord, webPush: false },
    },
  },
  DeviceDTO: {
    valid: { online: deviceDto, offline: { ...deviceDto, online: false } },
    invalid: {
      "online-must-be-boolean": { ...deviceDto, online: "yes" },
      "id-must-be-uuidv7": { ...deviceDto, id: "device-1" },
    },
  },
  PushRecord: {
    valid: {
      note: pushRecord,
      file: {
        ...pushRecord,
        id: SECOND_PUSH_ID,
        targetDeviceId: SECOND_DEVICE_ID,
        file: fileReference,
      },
    },
    invalid: {
      "version-must-be-one": { ...pushRecord, v: 2 },
      "target-must-be-uuidv7-or-null": { ...pushRecord, targetDeviceId: "all" },
    },
  },
  PushDTO: {
    valid: {
      note: pushDto,
      file: {
        ...pushDto,
        id: SECOND_PUSH_ID,
        targetDeviceId: SECOND_DEVICE_ID,
        file: fileReference,
      },
    },
    invalid: {
      "source-device-id-must-be-uuidv7": { ...pushDto, sourceDeviceId: "device-1" },
      "file-size-must-be-nonnegative": { ...pushDto, file: { ...fileReference, size: -1 } },
    },
  },
  Limits: {
    valid: { default: limits },
    invalid: {
      "max-file-bytes-must-be-nonnegative": { ...limits, maxFileBytes: -1 },
      "max-envelope-bytes-must-be-integer": { ...limits, maxEnvelopeBytes: 1.5 },
    },
  },
  UploadMode: {
    valid: { direct: "direct", proxy: "proxy", auto: "auto" },
    invalid: { "known-mode-required": "multipart", "string-required": false },
  },
  ErrorCode: {
    valid: { default: "bad_request", internal: "internal" },
    invalid: { "known-code-required": "invalid_request", "string-required": 400 },
  },
  ErrorBody: {
    valid: { default: { error: { code: "bad_request", message: "The request is invalid." } } },
    invalid: {
      "known-code-required": { error: { code: "invalid_request", message: "Invalid." } },
      "message-required": { error: { code: "bad_request" } },
    },
  },
  HealthResponse: {
    valid: { initialized: { ok: true, version: "1.0.0", initialized: true } },
    invalid: {
      "ok-must-be-true": { ok: false, version: "1.0.0", initialized: true },
      "initialized-must-be-boolean": { ok: true, version: "1.0.0", initialized: "yes" },
    },
  },
  SetupRequest: {
    valid: {
      default: {
        setupToken: "fake-setup-token",
        kdf,
        authKey: B64_32,
        keyCheck: B64_32,
        device: { name: "Chrome on macOS", platform: "web" },
      },
    },
    invalid: {
      "setup-token-must-be-nonempty": {
        setupToken: "",
        kdf,
        authKey: B64_32,
        keyCheck: B64_32,
        device: { name: "Chrome on macOS", platform: "web" },
      },
      "auth-key-must-be-32-bytes": {
        setupToken: "fake-setup-token",
        kdf,
        authKey: B64_16,
        keyCheck: B64_32,
        device: { name: "Chrome on macOS", platform: "web" },
      },
    },
  },
  SetupResponse: {
    valid: { default: { device: deviceDto, token: B64_32 } },
    invalid: {
      "token-must-be-32-bytes": { device: deviceDto, token: B64_16 },
      "device-required": { token: B64_32 },
    },
  },
  AuthParamsResponse: {
    valid: { default: { kdf } },
    invalid: {
      "kdf-required": {},
      "kdf-algorithm-must-match": { kdf: { ...kdf, alg: "PBKDF2-SHA1" } },
    },
  },
  LoginRequest: {
    valid: { default: { authKey: B64_32, device: deviceInput } },
    invalid: {
      "auth-key-must-be-32-bytes": { authKey: B64_16, device: deviceInput },
      "device-required": { authKey: B64_32 },
    },
  },
  LoginResponse: {
    valid: { default: { device: deviceDto, token: B64_32 } },
    invalid: {
      "token-must-be-32-bytes": { device: deviceDto, token: B64_16 },
      "device-required": { token: B64_32 },
    },
  },
  MeResponse: {
    valid: {
      auto: {
        device: deviceDto,
        keyCheck: B64_32,
        limits,
        vapidPublicKey: B64_65,
        uploadMode: "auto",
      },
      direct: {
        device: deviceDto,
        keyCheck: B64_32,
        limits,
        vapidPublicKey: B64_65,
        uploadMode: "direct",
      },
      proxy: {
        device: deviceDto,
        keyCheck: B64_32,
        limits,
        vapidPublicKey: B64_65,
        uploadMode: "proxy",
      },
    },
    invalid: {
      "key-check-must-be-32-bytes": {
        device: deviceDto,
        keyCheck: B64_16,
        limits,
        vapidPublicKey: B64_65,
        uploadMode: "auto",
      },
      "known-upload-mode-required": {
        device: deviceDto,
        keyCheck: B64_32,
        limits,
        vapidPublicKey: B64_65,
        uploadMode: "multipart",
      },
    },
  },
  ListDevicesResponse: {
    valid: { default: { devices: [deviceDto] }, empty: { devices: [] } },
    invalid: {
      "devices-must-be-array": { devices: deviceDto },
      "device-items-must-be-valid": { devices: [{ ...deviceDto, online: "yes" }] },
    },
  },
  UpdateDeviceRequest: {
    valid: { default: { name: "Work phone" } },
    invalid: { "name-required": {}, "name-must-be-string": { name: 9 } },
  },
  SubscribeWebPushRequest: {
    valid: { default: { subscription: webPush } },
    invalid: {
      "subscription-required": {},
      "subscription-keys-required": { subscription: { endpoint: webPush.endpoint } },
    },
  },
  CreatePairResponse: {
    valid: { default: { code: B64_16, expiresAt: EXPIRES_AT } },
    invalid: {
      "code-must-be-16-bytes": { code: B64_12, expiresAt: EXPIRES_AT },
      "expiry-must-be-timestamp": { code: B64_16, expiresAt: "in ten minutes" },
    },
  },
  ClaimPairRequest: {
    valid: { default: { code: B64_16, device: deviceInput } },
    invalid: {
      "code-must-be-16-bytes": { code: B64_12, device: deviceInput },
      "device-required": { code: B64_16 },
    },
  },
  ClaimPairResponse: {
    valid: { default: { device: deviceDto, token: B64_32 } },
    invalid: {
      "token-must-be-32-bytes": { device: deviceDto, token: B64_16 },
      "device-required": { token: B64_32 },
    },
  },
  CreateFileRequest: {
    valid: { default: { size: 65_560 } },
    invalid: { "size-must-be-nonnegative": { size: -1 }, "size-must-be-integer": { size: 10.5 } },
  },
  CreateFileResponse: {
    valid: {
      direct: {
        fileId: FILE_ID,
        upload: {
          method: "PUT",
          url: "https://storage.example.test/files/fake-upload",
          headers: { "content-type": "application/octet-stream" },
        },
        expiresAt: EXPIRES_AT,
      },
      proxy: {
        fileId: FILE_ID,
        upload: { method: "PUT", url: `/api/files/${FILE_ID}/content`, headers: {} },
        expiresAt: EXPIRES_AT,
      },
    },
    invalid: {
      "upload-method-must-be-put": {
        fileId: FILE_ID,
        upload: {
          method: "POST",
          url: "https://storage.example.test/files/fake-upload",
          headers: {},
        },
        expiresAt: EXPIRES_AT,
      },
      "file-id-must-be-uuidv7": {
        fileId: "file-1",
        upload: {
          method: "PUT",
          url: "https://storage.example.test/files/fake-upload",
          headers: {},
        },
        expiresAt: EXPIRES_AT,
      },
    },
  },
  GetFileResponse: {
    valid: {
      direct: {
        download: {
          url: "https://storage.example.test/files/fake-download",
          headers: { accept: "application/octet-stream" },
        },
        expiresAt: EXPIRES_AT,
      },
      proxy: {
        download: { url: `/api/files/${FILE_ID}/content`, headers: {} },
        expiresAt: EXPIRES_AT,
      },
    },
    invalid: {
      "download-url-must-be-http": {
        download: { url: "ftp://storage.example.test/file", headers: {} },
        expiresAt: EXPIRES_AT,
      },
      "headers-values-must-be-strings": {
        download: { url: "https://storage.example.test/file", headers: { accept: 1 } },
        expiresAt: EXPIRES_AT,
      },
    },
  },
  CreatePushRequest: {
    valid: {
      note: { id: PUSH_ID, targetDeviceId: null, envelope, file: null },
      file: {
        id: SECOND_PUSH_ID,
        targetDeviceId: SECOND_DEVICE_ID,
        envelope,
        file: { id: FILE_ID },
      },
    },
    invalid: {
      "id-must-be-uuidv7": { id: "push-1", targetDeviceId: null, envelope, file: null },
      "file-must-be-reference-or-null": {
        id: PUSH_ID,
        targetDeviceId: null,
        envelope,
        file: FILE_ID,
      },
    },
  },
  ListPushesQuery: {
    valid: {
      default: {},
      paged: { before: PUSH_ID, limit: 25 },
    },
    invalid: {
      "limit-at-least-one": { limit: 0 },
      "limit-at-most-one-hundred": { limit: 101 },
      "before-must-be-uuidv7": { before: "yesterday" },
    },
  },
  ListPushesResponse: {
    valid: {
      complete: { pushes: [pushDto], nextBefore: null },
      paged: { pushes: [pushDto], nextBefore: PUSH_ID },
      empty: { pushes: [], nextBefore: null },
    },
    invalid: {
      "next-before-required": { pushes: [pushDto] },
      "next-before-must-be-uuidv7-or-null": { pushes: [pushDto], nextBefore: "older" },
    },
  },
  HelloFrame: {
    valid: {
      initial: {
        type: "hello",
        token: B64_32,
        since: null,
        client: { platform: "android", version: "0.1.0" },
      },
      resume: {
        type: "hello",
        token: B64_32,
        since: PUSH_ID,
        client: { platform: "web", version: "1.0.0" },
      },
    },
    invalid: {
      "token-must-be-32-bytes": {
        type: "hello",
        token: B64_16,
        since: null,
        client: { platform: "android", version: "0.1.0" },
      },
      "since-must-be-uuidv7-or-null": {
        type: "hello",
        token: B64_32,
        since: "latest",
        client: { platform: "android", version: "0.1.0" },
      },
    },
  },
  PongFrame: {
    valid: { default: { type: "pong" } },
    invalid: { "discriminator-required": {}, "wrong-discriminator": { type: "ping" } },
  },
  ClientFrame: {
    valid: {
      hello: {
        type: "hello",
        token: B64_32,
        since: null,
        client: { platform: "android", version: "0.1.0" },
      },
      pong: { type: "pong" },
    },
    invalid: { "known-type-required": { type: "ping" }, "discriminator-required": {} },
  },
  ReadyFrame: {
    valid: { default: { type: "ready", deviceId: DEVICE_ID, serverTime: CREATED_AT } },
    invalid: {
      "device-id-must-be-uuidv7": { type: "ready", deviceId: "device-1", serverTime: CREATED_AT },
      "server-time-must-be-timestamp": { type: "ready", deviceId: DEVICE_ID, serverTime: "now" },
    },
  },
  PushFrame: {
    valid: { default: { type: "push", push: pushDto } },
    invalid: {
      "push-required": { type: "push" },
      "push-must-be-valid": { type: "push", push: { ...pushDto, id: "push-1" } },
    },
  },
  PushDeletedFrame: {
    valid: { default: { type: "push_deleted", id: PUSH_ID } },
    invalid: {
      "id-must-be-uuidv7": { type: "push_deleted", id: "push-1" },
      "wrong-discriminator": { type: "push", id: PUSH_ID },
    },
  },
  DeviceAddedFrame: {
    valid: { default: { type: "device_added", device: deviceDto } },
    invalid: {
      "device-required": { type: "device_added" },
      "wrong-discriminator": { type: "device_updated", device: deviceDto },
    },
  },
  DeviceUpdatedFrame: {
    valid: { default: { type: "device_updated", device: deviceDto } },
    invalid: {
      "device-required": { type: "device_updated" },
      "wrong-discriminator": { type: "device_added", device: deviceDto },
    },
  },
  DeviceRemovedFrame: {
    valid: { default: { type: "device_removed", id: DEVICE_ID } },
    invalid: {
      "id-must-be-uuidv7": { type: "device_removed", id: "device-1" },
      "wrong-discriminator": { type: "push_deleted", id: DEVICE_ID },
    },
  },
  ReplayDoneFrame: {
    valid: { default: { type: "replay_done" } },
    invalid: { "discriminator-required": {}, "wrong-discriminator": { type: "resync" } },
  },
  ResyncFrame: {
    valid: { default: { type: "resync" } },
    invalid: { "discriminator-required": {}, "wrong-discriminator": { type: "replay_done" } },
  },
  PingFrame: {
    valid: { default: { type: "ping" } },
    invalid: { "discriminator-required": {}, "wrong-discriminator": { type: "pong" } },
  },
  ServerFrame: {
    valid: {
      ready: { type: "ready", deviceId: DEVICE_ID, serverTime: CREATED_AT },
      push: { type: "push", push: pushDto },
      "push-deleted": { type: "push_deleted", id: PUSH_ID },
      "device-added": { type: "device_added", device: deviceDto },
      "device-updated": { type: "device_updated", device: deviceDto },
      "device-removed": { type: "device_removed", id: DEVICE_ID },
      "replay-done": { type: "replay_done" },
      resync: { type: "resync" },
      ping: { type: "ping" },
    },
    invalid: { "client-frame-forbidden": { type: "pong" }, "discriminator-required": {} },
  },
} as const satisfies Record<JsonSchemaName, SchemaFixtureDefinition>;

function fixturePath(
  schemaName: JsonSchemaName,
  expectation: FixtureExpectation,
  variant: string,
  validCount: number,
): string {
  if (expectation === "invalid") {
    return `invalid/${schemaName}--${variant}.json`;
  }

  const suffix = validCount === 1 && variant === "default" ? "" : `--${variant}`;
  return `valid/${schemaName}${suffix}.json`;
}

function createFixtureCases(): readonly FixtureCase[] {
  const cases: FixtureCase[] = [];

  for (const schemaName of Object.keys(fixtureDefinitions) as JsonSchemaName[]) {
    const definition = fixtureDefinitions[schemaName];
    const validEntries = Object.entries(definition.valid);

    for (const [variant, value] of validEntries) {
      cases.push({
        schemaName,
        path: fixturePath(schemaName, "valid", variant, validEntries.length),
        expectation: "valid",
        value,
      });
    }

    for (const [rule, value] of Object.entries(definition.invalid)) {
      cases.push({
        schemaName,
        path: fixturePath(schemaName, "invalid", rule, validEntries.length),
        expectation: "invalid",
        value,
      });
    }
  }

  return cases.sort((left, right) => {
    if (left.path < right.path) return -1;
    if (left.path > right.path) return 1;
    return 0;
  });
}

export const fixtureCases: readonly FixtureCase[] = createFixtureCases();

export function buildFixtures(): Record<string, string> {
  const fixtures: Record<string, string> = {};
  for (const { path, value } of fixtureCases) {
    fixtures[path] = `${JSON.stringify(value, null, 2)}\n`;
  }
  return fixtures;
}
