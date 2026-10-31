export const HKDF_LABELS = {
  contentKey: "pneumo/v1/content",
  authKey: "pneumo/v1/auth",
  checkKey: "pneumo/v1/check",
} as const;

export const KEY_CHECK_LABEL = "pneumo/v1/key-check";
export const PUSH_AAD_PREFIX = "pneumo/v1/push:";
export const FILE_AAD_PREFIX = "pneumo/v1/file:";

export const FILE_HEADER = [0x50, 0x4e, 0x4d, 0x46, 0x01, 0x00, 0x00, 0x00] as const;
export const FILE_CHUNK_SIZE = 65_536;

export const DEFAULT_LIMITS = {
  maxFileBytes: 524_288_000,
  maxEnvelopeBytes: 65_536,
} as const;

export const DEFAULT_KDF_ITERATIONS = 600_000;
export const DEFAULT_UPLOAD_MODE = "auto";
export const DEFAULT_WS_PING_SECONDS = 60;
export const WS_HELLO_TIMEOUT_MS = 10_000;

export const WS_CLOSE_CODES = {
  protocolError: 4_400,
  unauthorized: 4_401,
  restarting: 1_012,
} as const;

export const MAX_OBJECT_TIMESTAMP_MS = 9_999_999_999_999;
