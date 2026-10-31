import { createReadStream, createWriteStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  b64uDecode,
  b64uEncode,
  buildPairingUri,
  createFileDecryptor,
  createFileEncryptor,
  decryptPush,
  deriveKeys,
  deriveMasterKey,
  encryptPush,
  generateFileKey,
  keyCheck,
  newKdfParams,
  parsePairingUri,
} from "@pneumo/crypto";
import {
  AuthParamsResponse,
  ClaimPairRequest,
  ClaimPairResponse,
  CreateFileRequest,
  CreateFileResponse,
  CreatePairResponse,
  CreatePushRequest,
  ciphertextSize,
  GetFileResponse,
  LoginRequest,
  LoginResponse,
  MeResponse,
  PushDTO,
  type PushPayload,
  SetupRequest,
  SetupResponse,
  uuidv7,
} from "@pneumo/protocol";
import { SafeError } from "./errors.js";
import type { Session } from "./session.js";

type Schema<T> = { parse(input: unknown): T };

export async function request<T>(
  url: string,
  path: string,
  schema: Schema<T>,
  options: { method?: string; body?: unknown; token?: string; signal?: AbortSignal } = {},
): Promise<T> {
  const headers = new Headers();
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  const init: RequestInit = {
    method: options.method ?? "GET",
    headers,
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000),
    redirect: "error",
  };
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(new URL(path, url), init);
  if (!response.ok) throw new SafeError(`API request failed (HTTP ${response.status})`);
  if (response.status === 204) return schema.parse(undefined);
  return schema.parse(await response.json());
}

function sessionFor(url: string, mk: Uint8Array, result: SetupResponse): Session {
  return { url, deviceId: result.device.id, token: result.token, mk: b64uEncode(mk) };
}

export async function setup(url: string, setupToken: string, passphrase: string): Promise<Session> {
  const kdf = newKdfParams();
  const mk = await deriveMasterKey(passphrase, kdf);
  const { authKey } = await deriveKeys(mk);
  const body = SetupRequest.parse({
    setupToken,
    kdf,
    authKey: b64uEncode(authKey),
    keyCheck: b64uEncode(await keyCheck(mk)),
    device: { name: "cli", platform: "cli" },
  });
  return sessionFor(
    url,
    mk,
    await request(url, "/api/setup", SetupResponse, { method: "POST", body }),
  );
}

export async function login(url: string, passphrase: string, name = "cli"): Promise<Session> {
  const { kdf } = await request(url, "/api/auth/params", AuthParamsResponse);
  const mk = await deriveMasterKey(passphrase, kdf);
  const { authKey } = await deriveKeys(mk);
  const body = LoginRequest.parse({
    authKey: b64uEncode(authKey),
    device: { name, platform: "cli" },
  });
  const result = await request(url, "/api/auth/login", LoginResponse, { method: "POST", body });
  const session = sessionFor(url, mk, result);
  await new Client(session).checkKey();
  return session;
}

export async function claim(uri: string): Promise<Session> {
  const { origin, code, mk } = parsePairingUri(uri);
  const body = ClaimPairRequest.parse({ code, device: { name: "cli phone", platform: "android" } });
  const result = await request(origin, "/api/pair/claim", ClaimPairResponse, {
    method: "POST",
    body,
  });
  const session = sessionFor(origin, mk, result);
  const client = new Client(session);
  try {
    await client.checkKey();
  } catch (error) {
    await client.removeDevice(session.deviceId);
    throw error;
  }
  return session;
}

export type DecryptedPush = {
  id: string;
  type: PushPayload["type"];
  title: string | null;
  source: string;
  body?: string;
  url?: string;
  fileName?: string;
};

const noContent = { parse: (_value: unknown): void => {} };

export class Client {
  private readonly keys;

  constructor(readonly session: Session) {
    this.keys = deriveKeys(b64uDecode(session.mk));
  }

  api<T>(path: string, schema: Schema<T>, method = "GET", body?: unknown): Promise<T> {
    return request(this.session.url, path, schema, {
      method,
      token: this.session.token,
      ...(body === undefined ? {} : { body }),
    });
  }

  async checkKey(): Promise<void> {
    const me = await this.api("/api/me", MeResponse);
    if (me.keyCheck !== b64uEncode(await keyCheck(b64uDecode(this.session.mk)))) {
      throw new SafeError("The session key does not match the server");
    }
  }

  async pairUri(): Promise<string> {
    const { code } = await this.api("/api/pair", CreatePairResponse, "POST");
    return buildPairingUri({ origin: this.session.url, code, mk: b64uDecode(this.session.mk) });
  }

  async payload(push: PushDTO): Promise<PushPayload> {
    return decryptPush((await this.keys).contentKey, push.id, push.envelope);
  }

  async decrypted(push: PushDTO): Promise<DecryptedPush> {
    const payload = await this.payload(push);
    const row: DecryptedPush = {
      id: push.id,
      type: payload.type,
      title: payload.title ?? null,
      source: push.sourceDeviceId,
    };
    if (payload.body !== undefined) row.body = payload.body;
    if (payload.type === "link") row.url = payload.url;
    if (payload.type === "file") row.fileName = payload.file.name;
    return row;
  }

  async send(payload: PushPayload, to: string | null = null, fileId?: string): Promise<PushDTO> {
    const id = uuidv7();
    const envelope = await encryptPush((await this.keys).contentKey, id, payload);
    const { limits } = await this.api("/api/me", MeResponse);
    if (Buffer.byteLength(JSON.stringify(envelope)) > limits.maxEnvelopeBytes) {
      throw new SafeError("The encrypted push exceeds the server envelope limit");
    }
    const body = CreatePushRequest.parse({
      id,
      targetDeviceId: to,
      envelope,
      file: fileId ? { id: fileId } : null,
    });
    return this.api("/api/pushes", PushDTO, "POST", body);
  }

  private transfer(descriptor: { url: string; headers: Record<string, string> }) {
    const url = new URL(descriptor.url, this.session.url);
    const headers = new Headers(descriptor.headers);
    // Only the same-origin proxy endpoint receives the device credential, never S3.
    if (url.origin === this.session.url && url.pathname.startsWith("/api/files/")) {
      headers.set("Authorization", `Bearer ${this.session.token}`);
    }
    return { url, headers };
  }

  async sendFile(path: string, to: string | null = null): Promise<PushDTO> {
    const info = await stat(path);
    if (!info.isFile()) throw new SafeError("The upload path must be a regular file");
    const size = ciphertextSize(info.size);
    const { limits } = await this.api("/api/me", MeResponse);
    if (size > limits.maxFileBytes)
      throw new SafeError("The encrypted file exceeds the server file limit");
    const reservation = await this.api(
      "/api/files",
      CreateFileResponse,
      "POST",
      CreateFileRequest.parse({ size }),
    );
    const fk = generateFileKey();
    const { url, headers } = this.transfer(reservation.upload);
    headers.set("Content-Length", String(size));
    const input = createReadStream(path);
    const encrypted = Readable.toWeb(input).pipeThrough(
      createFileEncryptor(fk, reservation.fileId),
    );
    const init: RequestInit & { duplex: "half" } = {
      method: reservation.upload.method,
      headers,
      body: encrypted,
      duplex: "half",
      redirect: "error",
    };
    try {
      const response = await fetch(url, init);
      await response.body?.cancel();
      if (!response.ok) throw new SafeError(`File upload failed (HTTP ${response.status})`);
    } finally {
      input.destroy();
    }
    return this.send(
      {
        type: "file",
        file: {
          name: basename(path),
          mime: "application/octet-stream",
          size: info.size,
          key: b64uEncode(fk),
        },
      },
      to,
      reservation.fileId,
    );
  }

  async download(id: string, out: string): Promise<void> {
    const push = await this.api(`/api/pushes/${id}`, PushDTO);
    const payload = await this.payload(push);
    if (payload.type !== "file" || !push.file) throw new SafeError("The push is not a file");
    const descriptor = await this.api(`/api/files/${push.file.id}`, GetFileResponse);
    const { url, headers } = this.transfer(descriptor.download);
    const response = await fetch(url, { headers, redirect: "error" });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new SafeError(`File download failed (HTTP ${response.status})`);
    }
    const temporary = join(dirname(out), `.${basename(out)}.pneumo-${uuidv7()}`);
    try {
      const plaintext = response.body.pipeThrough(
        createFileDecryptor(b64uDecode(payload.file.key), push.file.id),
      );
      await pipeline(
        Readable.fromWeb(plaintext),
        createWriteStream(temporary, { mode: 0o600, flags: "wx" }),
      );
      if ((await stat(temporary)).size !== payload.file.size)
        throw new SafeError("The downloaded file size differs from its payload");
      await rename(temporary, out);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  deletePush(id: string): Promise<void> {
    return this.api(`/api/pushes/${id}`, noContent, "DELETE");
  }

  removeDevice(id: string): Promise<void> {
    return this.api(`/api/devices/${id}`, noContent, "DELETE");
  }
}
