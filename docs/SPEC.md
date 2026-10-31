# Pneumo spec v1

**Status:** locked for the MVP build (2026-10-30). The M0 scaffold issue copies this document verbatim to `docs/SPEC.md`. After that merges, `docs/SPEC.md` in the repo is the source of truth and this document is only a mirror.

Pneumo is a self-hosted, end-to-end encrypted replacement for the core of Pushbullet. You send notes, links and files between your own browser and Android phone and get instant notifications. Each deployment has one user. A deployment is one small server plus any S3-compatible bucket.

## 1. Scope

### 1.1 In the MVP

* Send notes (text), links and files from the web app and the Android app, to all devices or to one device.
* Android notifications for incoming pushes, with actions: **Copy** (notes, links), **Open** (links), and **Download** then **Open/Share** (files). Pneumo also appears as a target in the Android share sheet.
* Browser: an installable web app (PWA) with history, a composer, device management, a pairing QR code, and browser notifications through Web Push.
* End-to-end encryption of all push content and all file bytes.
* One-click deploy on Railway (a template with one service and one bucket). A Docker image for other hosts with any S3-compatible storage.

### 1.2 Not in the MVP

See §19.

## 2. Locked decisions (do not re-litigate)

| Topic | Decision |
| -- | -- |
| Name | **Pneumo.** Theme: retro pneumatic-tube office mail. |
| Users | One owner per deployment. No sign-up. Other people self-host their own instance. |
| Server | TypeScript on Node 26 LTS with Hono. One always-on instance, replicas = 1. |
| Storage | One S3-compatible bucket holds everything: files, push history, devices, instance metadata. No database, no volume. |
| Delivery to Android | A persistent WebSocket held by a foreground service. No FCM. No dependency on Google Play Services anywhere in the app. |
| Delivery to browsers | Web Push (VAPID) to a service worker, plus a WebSocket while the web app is open. |
| Browser client | A PWA served by the server at `/`. The browser extension is Phase 2. |
| Android client | Native Kotlin + Jetpack Compose. |
| Encryption | End-to-end, always on, no toggle. One passphrase per deployment. The server never sees the passphrase, the keys or any plaintext. |
| Push types | `note`, `link`, `file`. |
| Source and CI | **Tangled** ([tangled.org/demi.dev/pneumo](<https://tangled.org/demi.dev/pneumo>)) is the source of truth: pull requests, review and CI (spindle workflows in `.tangled/workflows/`). |
| Distribution | A read-only **GitHub mirror** (`github.com/stoopkidddd/pneumo`) receives `main` and tags only when a release is cut. The APK goes on its GitHub Releases, the Docker image on GHCR, and the Railway service and template deploy from it. Releases are built on the owner's Mac. |
| Owner's hosting | The owner's Railway account: one service plus one Railway Bucket. |
| Secrets | No Infisical or varlock in this project (planning default, so one-click deploy needs no third-party service). Production secrets live only in Railway variables. Development uses MinIO with fake credentials. |
| License | MIT (planning default). |
| Tooling | mise (tools and tasks), pnpm workspaces, Biome, vitest, Playwright. Android: Gradle KTS + version catalog, Spotless/ktlint, detekt, Android Lint, JUnit + Robolectric + Turbine, Roborazzi, Gradle Managed Devices. |

## 3. Architecture

```
 Web app (PWA) ──REST + WS──┐                    ┌── S3 API ───► Bucket
                            ├──► Pneumo server ──┤
 Android app ───REST + WS───┘    (Hono, Node)    └── Web Push ─► browser push service ─► service worker
      │
      └──── presigned PUT / GET (file bytes, direct mode) ──────► Bucket
```

How a note travels: the sender encrypts the payload, then calls `POST /api/pushes`. The server stores the record in the bucket, broadcasts it to every connected WebSocket, and sends Web Push to subscribed browsers. Each receiver decrypts it and shows a notification.

### 3.1 What the server can see

Push ids, timestamps, source and target device ids, ciphertext sizes, file ids, device names and platforms, client IP addresses, and Web Push endpoints. Everything else is ciphertext: the push type, text, URL, file name, MIME type and file bytes.

## 4. Repository layout and tooling

```
apps/server/            Hono server; also serves apps/web/dist at /
apps/web/               React 19 + Vite PWA
apps/android/           Gradle project (Kotlin, Compose), application id dev.pneumo.app
packages/protocol/      @pneumo/protocol: zod schemas + TS types for every DTO, route and WS frame; JSON fixtures
packages/crypto/        @pneumo/crypto: §6 in TypeScript (WebCrypto only: browser, service worker, Node)
packages/crypto/vectors/v1.json    cross-language test vectors (TS and Kotlin both test against it)
brand/                  logo and icon sources, exports, DESIGN.md, tokens.json
scripts/                dev client CLI, asset generation, e2e harness
docs/SPEC.md            this spec
docs/adr/NNNN-*.md      decisions made during the build
mise.toml  pnpm-workspace.yaml  biome.json  tsconfig.base.json  Dockerfile  docker-compose.yml  .tangled/workflows/
CLAUDE.md               agent conventions for this repo (AGENTS.md is a symlink to it)
docs/agents/tangled.md  the proven PR, review-round, merge and CI commands for Tangled
```

* Workspace packages (all private): `@pneumo/protocol`, `@pneumo/crypto`, `@pneumo/server`, `@pneumo/web`.
* `mise.toml` pins Node 26, pnpm and Java temurin-17, and sets `ANDROID_HOME`.
* mise tasks: `check` (runs every lane check), `check:protocol`, `check:server`, `check:web`, `check:android`, `check:infra`, `check:brand`, `e2e:server`, `e2e:web`, `e2e:android`, `e2e:docker`, `dev`, `dev:infra`, `brand:export`, `android:setup`, `release`.

## 5. Data model and bucket layout

### 5.1 Encoding and ids

* Binary values in JSON are base64url without padding (**b64u**).
* Strings are UTF-8.
* Push ids and device ids are UUIDv7, as lowercase canonical strings. The **sending client** generates the push id, because it is the AAD (§6.5). The **server** generates device ids and file ids.
* Timestamps are ISO 8601 UTC with milliseconds, for example `2026-10-30T12:00:00.000Z`.
* The server sets `createdAt` when it receives a push. Pushes are ordered by (`createdAt`, `id`).

### 5.2 Plaintext push payload

The payload is always encrypted inside the envelope (§6.5). It is never sent in the clear.

```ts
type PushPayload =
  | { type: "note"; title?: string; body: string }
  | { type: "link"; title?: string; body?: string; url: string }   // http(s) URLs only
  | { type: "file"; title?: string; body?: string;
      file: { name: string; mime: string; size: number /* plaintext bytes */; key: string /* b64u, 32 bytes */ } };
```

* The serialized envelope must be at most `MAX_ENVELOPE_BYTES` (default 65,536). Clients refuse to send a note that would exceed this and tell the user why.
* **Link detection** (clients): if the trimmed text is exactly one http(s) URL, the push is a `link` with `url` = that text. Otherwise it is a `note`.

### 5.3 Objects in the bucket

All keys sit under the optional `S3_PREFIX`.

| Key | Content | Written by |
| -- | -- | -- |
| `meta/owner.json` | owner record (§7.2) | setup |
| `meta/vapid.json` | VAPID keypair and subject | first boot |
| `devices/<deviceId>.json` | device record | setup, login, claim, rename, Web Push subscribe |
| `pushes/<invTs>_<pushId>.json` | push record | `POST /api/pushes` |
| `files/<fileId>` | encrypted file stream (§6.6) | client (presigned PUT) or server (proxy mode) |

`invTs` = `9999999999999 − createdAtMs`, zero-padded to 13 digits. ListObjectsV2 then returns the newest pushes first.

**Device record**

```json
{ "v": 1, "id": "…", "name": "Pixel 9", "platform": "android", "createdAt": "…", "lastSeenAt": "…",
  "tokenHash": "b64u(SHA-256(token))", "webPush": null }
```

`platform` is one of `web`, `android`, `desktop`, `cli`. `webPush` is `{ "endpoint", "keys": { "p256dh", "auth" } }` or `null`.

**Push record**

```json
{ "v": 1, "id": "…", "createdAt": "…", "sourceDeviceId": "…", "targetDeviceId": null,
  "envelope": { "v": 1, "n": "b64u", "c": "b64u" },
  "file": { "id": "…", "size": 123456 } }
```

`file` is `null` for notes and links. `file.size` is the **ciphertext** size in bytes.

### 5.4 DTOs

* `PushDTO` = the push record without `v`.
* `DeviceDTO` = `{ id, name, platform, createdAt, lastSeenAt, online }`. It never contains `tokenHash` or `webPush`.
* `@pneumo/protocol` is the source of truth for every DTO. The Kotlin models mirror it and are tested against its fixtures (§17).

## 6. Cryptography (normative)

Every implementation (TypeScript `@pneumo/crypto`, Kotlin `dev.pneumo.app.crypto`) must pass `packages/crypto/vectors/v1.json`.

### 6.1 Master key

`MK = PBKDF2-HMAC-SHA256(P = UTF-8(NFC(passphrase)), S = kdf.salt, c = kdf.iterations, dkLen = 32)`

* `kdf.salt` is 16 random bytes, made at setup.
* `kdf.iterations` is 600,000 for new instances. The value is stored with the salt, so it can be raised later.
* Passphrases are at least 12 characters (clients enforce this).
* NFC: `s.normalize("NFC")` in JS, `Normalizer.normalize(s, Normalizer.Form.NFC)` in Kotlin.

### 6.2 Subkeys

`HKDF-SHA256(IKM = MK, salt = empty, info = UTF-8(label), L = 32)`. An empty salt is the same as 32 zero bytes (RFC 5869).

| Key | label |
| -- | -- |
| `contentKey` | `pneumo/v1/content` |
| `authKey` | `pneumo/v1/auth` |
| `checkKey` | `pneumo/v1/check` |

### 6.3 Key check

`keyCheck = HMAC-SHA256(key = checkKey, msg = UTF-8("pneumo/v1/key-check"))`, 32 bytes.

The server stores it. Only the authenticated `GET /api/me` returns it. Clients use it to confirm that a scanned or entered key is correct. It is **never** returned by an unauthenticated endpoint, because that would allow offline guessing of the passphrase.

### 6.4 Server-side auth verifier

The server never receives the passphrase or MK. At setup and login it receives `authKey` (b64u) and stores `scrypt(authKey bytes, salt = 16 random bytes, N = 16384, r = 8, p = 1, dkLen = 32)`. It verifies with a constant-time compare.

### 6.5 Push envelope

* `nonce` = 12 random bytes.
* AES-256-GCM with key = `contentKey`, AAD = `UTF-8("pneumo/v1/push:" + pushId)`, plaintext = `UTF-8(JSON.stringify(payload))`.
* `envelope = { "v": 1, "n": b64u(nonce), "c": b64u(ciphertext ‖ tag) }`, with the 16-byte tag appended (the WebCrypto and `AES/GCM/NoPadding` default).

### 6.6 File stream

* `FK` = 32 random bytes per file. It travels inside the push payload (`file.key`).
* **Header** (8 bytes): ASCII `PNMF` ‖ `0x01` (version) ‖ `0x00 0x00 0x00`.
* **Chunking:** chunk size 65,536. `n = max(1, ceil(size / 65536))`. Chunk `i` is the plaintext bytes `[i·65536, min((i+1)·65536, size))`.
* `Nonce_i` (12 bytes) = `0x00 0x00 0x00` ‖ `uint64_be(i)` ‖ (`0x01` if `i == n − 1`, else `0x00`).
* AAD = `UTF-8("pneumo/v1/file:" + fileId)`.
* Each chunk becomes `AES-256-GCM(FK, Nonce_i, chunk, AAD)` = `|chunk| + 16` bytes.
* Total ciphertext size = `8 + size + 16·n`. Clients compute it before encrypting, because `POST /api/files` needs it.
* **Decrypting:** read blocks of 65,552 bytes. A block is the last one if and only if no bytes follow it; decrypt it with the last-chunk flag set. Truncating at a chunk boundary therefore fails the tag check. Decryption **must** fail on: a wrong header or version, any tag failure, a block shorter than 16 bytes, or an empty last chunk when `n > 1`.
* APIs: TS `TransformStream<Uint8Array, Uint8Array>` for encrypt and decrypt, plus Blob helpers. Kotlin `InputStream`/`OutputStream` (or Okio) wrappers.

### 6.7 Pairing URI

`pneumo://pair?v=1&u=<percent-encoded server origin>&c=<pairing code>&k=<b64u MK>`

It is shown as a QR code (error correction level M). The Android app also accepts it as a deep link (used by tests) and as pasted text.

### 6.8 Randomness

Use only WebCrypto `getRandomValues` and `java.security.SecureRandom`.

### 6.9 Key storage

* **Web:** IndexedDB database `pneumo`, store `session`: `{ deviceId, token, mk }` (raw MK bytes, needed to draw pairing QR codes), plus `contentKey` as a non-extractable `CryptoKey`.
* **Android:** MK and the device token are encrypted with an Android Keystore AES-256-GCM key (alias `pneumo_wrap`, no user-auth requirement). The ciphertext is kept in DataStore.
* Sign-out and revoke delete both.

### 6.10 Test vectors (`packages/crypto/vectors/v1.json`)

* **Sections:** `kdf` (one case at 600,000 iterations, plus fast cases at 1,000), `hkdf`, `keyCheck`, `authKey`, `envelope` (fixed nonce), `file` (sizes 0, 1, 65,535, 65,536, 65,537 and 200,000, with a fixed FK and fileId; full ciphertext as b64u for sizes up to 65,537, SHA-256 of the ciphertext for larger ones), `negative` (tampered tag, truncation at a chunk boundary, trailing bytes, wrong AAD, wrong header).
* Generated deterministically by `pnpm --filter @pneumo/crypto vectors:generate`. A change to this file needs a commit message that says so.

### 6.11 Threat model

* **Protects content against:** the bucket provider, anyone who gets the bucket credentials or a bucket dump, and the Web Push services.
* **Does not protect against:**
  * a compromised server that serves modified web-app JavaScript (the web client trusts its origin);
  * metadata (§3.1);
  * a compromised device.
* Passphrase change is not in v1 (§19).
* If the passphrase is forgotten, existing data cannot be decrypted. Recovery is a wipe (`pneumo reset`, §12.5) and a new setup.

## 7. Setup, auth and pairing

### 7.1 Setup token

While the instance is uninitialized (no `meta/owner.json`), `POST /api/setup` needs a setup token. The token is `PNEUMO_SETUP_TOKEN` if that is set. Otherwise the server makes a random 32-byte b64u token at boot and logs it **once**, at warn level:

`Pneumo is not set up yet. Open <PUBLIC_URL>/setup#token=<token>`

It is never logged again and becomes useless after setup.

### 7.2 Setup (web)

1. `/setup` reads the token from the URL fragment.
2. The user enters the passphrase twice (at least 12 characters) and a device name. The default name comes from the user agent, for example "Chrome on macOS".
3. The client makes the salt, then derives MK (§6.1, with a busy state), `authKey` and `keyCheck`, and calls `POST /api/setup`.
4. The server writes `meta/owner.json` = `{ v, createdAt, kdf: { alg: "PBKDF2-SHA256", iterations, salt }, authVerifier: { alg: "scrypt", N, r, p, salt, hash }, keyCheck }` and the first device. It returns `{ device, token }`. An in-process mutex stops concurrent setup (there is one replica). Also use a conditional write (`If-None-Match: *`) if the store supports it.
5. The UI shows a one-time warning: "If you forget this passphrase, your history can't be recovered."

### 7.3 Login (another browser)

1. `GET /api/auth/params` → `{ kdf }`.
2. Passphrase → MK → `authKey` → `POST /api/auth/login { authKey, device }` → `{ device, token }`.
3. Failure rate limits: 5 failures per 15 minutes per client IP, and 30 failures per 15 minutes globally. Over the limit, the server returns `429` with `Retry-After`. A success resets that IP's counter.

### 7.4 Device tokens

* 32 random bytes, b64u. The server stores only the SHA-256 hash.
* Sent as `Authorization: Bearer <token>`.
* No expiry. Deleting the device revokes its token.
* `lastSeenAt` is written at most once per minute per device.

### 7.5 Pairing a phone

1. An authenticated web client calls `POST /api/pair` → `{ code, expiresAt }`. The code is 16 random bytes (b64u), valid for 10 minutes, single use, and kept in memory only.
2. The web app shows the §6.7 QR code with a countdown and a **New code** button.
3. The phone scans the code (or opens the deep link) and shows a confirm screen: "Pair with [pneumo.example.com](<http://pneumo.example.com>)?".
4. The phone calls `POST /api/pair/claim { code, device: { name, platform: "android" } }` → `{ device, token }`, then calls `GET /api/me` and compares `keyCheck` with the value it computes from `k`.
5. **Mismatch:** the phone deletes its own device, wipes local state and shows "This QR code's key doesn't match the server. Make a new code and scan again."
6. The web modal closes by itself when it receives the `device_added` WebSocket event for the new device.

### 7.6 No cookies

Bearer tokens only, so there is no CSRF surface. `/api` sends no CORS headers (same origin only). Native clients are not affected by CORS.

## 8. HTTP API (normative)

**Conventions**

* JSON bodies, validated with the `@pneumo/protocol` zod schemas. Unknown fields are stripped. JSON bodies are at most 128 KiB.
* Errors: `{ "error": { "code": "snake_case", "message": "…" } }`.
* Error codes: `bad_request` 400, `unauthorized` 401, `forbidden` 403, `not_found` 404, `conflict` 409, `not_initialized` 409, `gone` 410, `payload_too_large` 413, `rate_limited` 429, `internal` 500.

| Method and path | Auth | Request | Success and notable errors |
| -- | -- | -- | -- |
| `GET /api/health` | none | — | 200 `{ ok: true, version, initialized }` |
| `POST /api/setup` | setup token (in body) | `{ setupToken, kdf, authKey, keyCheck, device: { name, platform } }` | 201 `{ device, token }`; 403 bad token; 409 already initialized |
| `GET /api/auth/params` | none | — | 200 `{ kdf }`; 409 `not_initialized` |
| `POST /api/auth/login` | none | `{ authKey, device }` | 201 `{ device, token }`; 401; 429 |
| `GET /api/me` | bearer | — | 200 `{ device, keyCheck, limits: { maxFileBytes, maxEnvelopeBytes }, vapidPublicKey, uploadMode }` |
| `GET /api/devices` | bearer | — | 200 `{ devices: DeviceDTO[] }` |
| `PATCH /api/devices/:id` | bearer | `{ name }` | 200 `DeviceDTO` |
| `DELETE /api/devices/:id` | bearer | — | 204; that device's sockets close with 4401; broadcasts `device_removed` |
| `PUT /api/devices/self/webpush` | bearer | `{ subscription: { endpoint, keys: { p256dh, auth } } }` | 204 |
| `DELETE /api/devices/self/webpush` | bearer | — | 204 |
| `POST /api/pair` | bearer | — | 201 `{ code, expiresAt }` |
| `POST /api/pair/claim` | none (the code is the credential) | `{ code, device }` | 201 `{ device, token }`; 410 expired or used |
| `POST /api/files` | bearer | `{ size }` (ciphertext bytes) | 201 `{ fileId, upload: { method: "PUT", url, headers }, expiresAt }`; 413 |
| `PUT /api/files/:id/content` | bearer | raw body (proxy mode only) | 204 |
| `GET /api/files/:id` | bearer | — | 200 `{ download: { url, headers }, expiresAt }` |
| `GET /api/files/:id/content` | bearer | — | 200 byte stream (proxy mode only) |
| `POST /api/pushes` | bearer | `{ id, targetDeviceId, envelope, file: { id } \| null }` | 201 `PushDTO`; 200 if the same id is already stored with an identical body; 409 if the body differs |
| `GET /api/pushes?before=&limit=` | bearer | — | 200 `{ pushes: PushDTO[], nextBefore }`, newest first; limit 1–100, default 50 |
| `GET /api/pushes/:id` | bearer | — | 200 `PushDTO` |
| `DELETE /api/pushes/:id` | bearer | — | 204; deletes the file object; broadcasts `push_deleted` |
| `GET /api/ws` | token in the first frame | WebSocket upgrade | §9 |

`POST /api/pushes` **validation:** `id` is a UUIDv7. The envelope is at most `MAX_ENVELOPE_BYTES` (else 413). `targetDeviceId` is `null` or an existing device (else 400). If there is a file: this server issued the file id, the id is not attached to another push (else 409), and HEAD shows exactly the size declared at `POST /api/files` (else 400).

`POST /api/pushes` **effects:**

1. Set `createdAt`, write the record, and add it to the index.
2. Broadcast `push` to every connected socket, including the sender's other sessions.
3. Send Web Push to every `web` device that has a subscription, where the device is not the source and the target is `null` or that device.

**Presigned URLs:** PUT signs `ContentLength = size` and expires after 1 hour. GET expires after 10 minutes.

## 9. WebSocket protocol (normative)

* **Endpoint:** `GET /api/ws`. JSON text frames of the form `{ "type": … }`.
* **Hello.** Within 10 seconds the client sends `{ "type": "hello", "token": "…", "since": "<pushId>" | null, "client": { "platform": "android", "version": "0.1.0" } }`. Otherwise the server closes with 4401.
* **Ready and replay.** The server answers `{ "type": "ready", "deviceId", "serverTime" }`.
  * If `since` is in the index, the server sends every push after it as `push` frames (oldest first, at most 200), then `{ "type": "replay_done" }`.
  * If `since` is unknown, or more than 200 pushes are newer, it sends `{ "type": "resync" }`. The client then refetches with `GET /api/pushes`.
  * If `since` is `null`, it sends `ready` then `replay_done`, with no replay.
* **Server → client frames:** `push { push }`, `push_deleted { id }`, `device_added { device }`, `device_updated { device }`, `device_removed { id }`, `replay_done`, `resync`, `ping`.
* **Client → server frames:** `hello` and `pong` only. Any other frame closes the socket with 4400.
* **Heartbeat (app-level, so every client can observe it):**
  * The server sends `{ "type": "ping" }` every `WS_PING_SECONDS` (default 60). The client answers `{ "type": "pong" }`.
  * The server closes sockets that miss two pongs.
  * A client that receives no frame for `2 × WS_PING_SECONDS + 15` seconds treats the connection as dead and reconnects.
  * Android OkHttp `pingInterval` stays disabled.
* **Reconnect:** backoff with full jitter: 1, 2, 5, 10, 30, then 60 seconds (cap). Reset after 60 seconds connected. Retry at once when the network comes back.
* **Close codes:**
  * 4401: unauthorized or revoked. The client must not retry; it goes to the signed-out state.
  * 4400: protocol error.
  * 1012: server restarting. Retry after 1–3 seconds.
* **Delivery is at-least-once.** Clients dedupe by push id.

## 10. Web Push

* At first boot, if `meta/vapid.json` is missing, the server makes a VAPID keypair (P-256, `web-push.generateVAPIDKeys`). The subject is `VAPID_SUBJECT`, or `PUBLIC_URL` if that is unset.
* Sending follows the targeting rules in §8. TTL 86,400 seconds, urgency `high`. Sending is fire-and-forget through a small bounded queue, so it never delays the `POST /api/pushes` response.
* **Payload:** `{ "t": "push", "push": PushDTO }` if its UTF-8 length is at most 3,000 bytes. Otherwise `{ "t": "ref", "id": "…" }`, and the service worker fetches `GET /api/pushes/:id` with the stored token.
* A 404 or 410 from the push service clears that device's `webPush`.
* **Service worker:**
  1. Decrypts with `contentKey` from IndexedDB.
  2. Calls `showNotification(title, { body, tag: pushId, icon, badge, data: { pushId, url? }, actions })`. Links get the action `{ action: "open", title: "Open link" }`.
  3. On a plain click, it focuses an open app window and posts a message to it, or opens `/?push=<id>`.
  4. The `open` action calls `clients.openWindow(url)`.
  5. A service worker cannot write to the clipboard, so Copy happens in the app: the deep-linked item opens with its Copy button focused.
  6. If no keys are stored (signed out), it shows a generic "New push" notification, because `userVisibleOnly` requires a notification.
* **Targets:** Chrome, Edge and Firefox on desktop, and Chrome on Android. Safari is not targeted.

## 11. Files

* `MAX_FILE_BYTES` is 524,288,000 (500 MiB) of ciphertext by default. Uploads are a single PUT; multipart is Phase 2.
* **Upload mode** `UPLOAD_MODE` is `auto` (default), `direct` or `proxy`.
  * **auto:** at boot the server applies bucket CORS (`PutBucketCors`: AllowedOrigins `[PUBLIC_URL]`, methods GET/PUT/HEAD, headers `*`, ExposeHeaders `[ETag]`, MaxAge 3600), then reads it back with `GetBucketCors`. If both work, the mode is direct; otherwise it is proxy, logged at warn.
  * **direct:** presigned URLs.
  * **proxy:** the server streams the bytes to and from the bucket through `/api/files/:id/content`. On Railway this counts as service egress.
* **Upload (client):**
  1. Compute the ciphertext size (§6.6).
  2. `POST /api/files`.
  3. Stream-encrypt and PUT.
  4. `POST /api/pushes` with `file.id`.

  The web client builds a Blob of encrypted chunks and then PUTs it, because fetch cannot stream a request body to S3. It reports progress with XMLHttpRequest upload events. Android streams through an OkHttp `RequestBody` with a known length.
* **Download:** `GET /api/files/:id` → GET the returned URL → stream-decrypt → save. The web client decrypts to a Blob and saves it through an object URL with `<a download=name>`. For Android, see §14.9.
* **Orphans:** an hourly sweep deletes file objects older than 24 hours that no push references.
* **Retention:** `RETENTION_DAYS` (default 0 = keep forever). A daily sweep deletes older pushes and their files. Railway Buckets have no lifecycle rules, so the server does the sweeping.

## 12. Server behaviour and configuration

### 12.1 Process

* One Node process. Hono through `@hono/node-server`, with WebSockets on the same HTTP server (`ws` or `@hono/node-ws`).
* Compiled to `dist` with tsc or tsup, and run as `node dist/index.js`.
* `createApp(deps)` takes config, storage, clock and logger, so tests can inject fakes.

### 12.2 In-memory index

* At boot, list `pushes/` and load every record (32 at a time) into a sorted structure. Load all devices too.
* Soft limit: about 20,000 pushes (documented). Compaction is Phase 2.
* Every 30 seconds, list the first 100 keys of `pushes/` and merge any records the server doesn't know yet. This catches writes from an old instance during a deploy overlap. Merged records are broadcast.

### 12.3 Configuration

The server validates its environment with zod at boot. On error it prints every problem and exits with code 1.

| Variable | Default | Notes |
| -- | -- | -- |
| `PORT` | 8080 | Railway sets it. |
| `PUBLIC_URL` | `https://$RAILWAY_PUBLIC_DOMAIN` when that is set | Origin with no trailing slash. Required otherwise. |
| `S3_ENDPOINT` | — | Required. |
| `S3_REGION` | `auto` |  |
| `S3_BUCKET` | — | Required. |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | — | Required. Secret. |
| `S3_FORCE_PATH_STYLE` | `false` | `true` for MinIO. |
| `S3_PREFIX` | `""` | Lets several instances share one bucket. |
| `PNEUMO_SETUP_TOKEN` | generated (§7.1) | Secret. |
| `MAX_FILE_BYTES` | 524288000 |  |
| `MAX_ENVELOPE_BYTES` | 65536 |  |
| `RETENTION_DAYS` | 0 | 0 = forever. |
| `UPLOAD_MODE` | `auto` | `auto`, `direct` or `proxy`. |
| `WS_PING_SECONDS` | 60 |  |
| `VAPID_SUBJECT` | `PUBLIC_URL` |  |
| `TRUST_PROXY` | `true` when `RAILWAY_ENVIRONMENT` is set | Take the client IP from `X-Forwarded-For`. |
| `WEB_DIST_DIR` | `../web/dist` relative to the server | Override in tests. |
| `LOG_LEVEL` | `info` |  |

The Railway template maps the bucket's variables: `S3_ENDPOINT=${{Bucket.ENDPOINT}}`, `S3_BUCKET=${{Bucket.BUCKET}}`, `S3_REGION=${{Bucket.REGION}}`, `S3_ACCESS_KEY_ID=${{Bucket.ACCESS_KEY_ID}}`, `S3_SECRET_ACCESS_KEY=${{Bucket.SECRET_ACCESS_KEY}}`.

### 12.4 Logging

pino, JSON. Redact: the `Authorization` header, `token`, `authKey`, `setupToken`, `envelope`, presigned URL query strings and Web Push keys. Tests capture logs and assert the redaction. The only exception is the one setup-URL line in §7.1.

### 12.5 CLI

* `node dist/cli.js info`: initialized or not, device count, push count, upload mode.
* `node dist/cli.js reset --yes`: deletes every object under `S3_PREFIX`. It refuses to run without `--yes`.
* On Railway, run them with `railway ssh` or as a one-off command.

### 12.6 HTTP hardening

* **CSP:** `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self' wss://<host> <bucket origin in direct mode>; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`. Compute the bucket origin at boot from the S3 config; virtual-hosted style gives `https://<bucket>.<endpoint host>`.
* Also send: HSTS (over HTTPS), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and a restrictive `Permissions-Policy`.
* **Caching:** hashed assets get `immutable` with a 1-year max-age. `index.html`, `sw.js` and the manifest get `no-cache`.
* **SPA fallback:** any GET outside `/api` with no matching file serves `index.html`. Unknown `/api` routes get a JSON 404.

### 12.7 Shutdown

On SIGTERM: stop accepting connections, close sockets with 1012, wait up to 10 seconds for in-flight requests, then exit.

## 13. Web app

* **Stack:** React 19, Vite, TypeScript strict, a small router, and plain CSS using brand tokens. `src/styles/tokens.css` is generated from `brand/tokens.json`. No component library. Fonts are self-hosted. QR codes come from the `qrcode` npm package. A typed API client is built from the protocol route table. TanStack Query is allowed.
* **Routes:** `/setup`, `/login`, `/` (Home), `/devices`, `/settings`. Signed-out users go to `/login`, or to `/setup` when `/api/health` says the instance is uninitialized.
* **Home**
  * Composer at the top. Enter sends; Shift+Enter adds a new line. Attach button, drag-and-drop and paste for files and images. Target picker: "All devices" or one device. Send button.
  * History below, newest first, with infinite scroll. Each item shows a type icon, title, body (clamped, can expand), source device and relative time.
  * Item actions: Copy (note text or link URL), Open (links), Download (files), Delete (confirmed in place, never with a browser dialog).
  * `?push=<id>` scrolls to the item, highlights it and focuses its Copy button.
* **Devices**
  * List with platform icon, online dot and last-seen time. Inline rename. Remove, confirmed in place.
  * "Add a phone" opens a modal with the §6.7 QR code, a countdown and **New code**. The modal closes on `device_added`.
* **Settings:** browser notifications on/off (asks for permission, subscribes, `PUT …/webpush`), this device's name, sign out (`DELETE` own device, wipe IndexedDB), version and server info.
* **Live updates:** a §9 WebSocket client while the app is open. It reconnects on `online` and `visibilitychange`. A 4401 close signs the user out with a message.
* **PWA:**
  * Manifest: name and short_name "Pneumo", icons 192, 512 and maskable 512, theme and background colours from the brand, `display: standalone`.
  * Service worker through `vite-plugin-pwa` (injectManifest): precaches the app shell, handles push (§10) and `notificationclick`, and shows a "Reload to update" prompt when a new version is ready.
* **Quality:** plain-language empty states and errors, light and dark (`prefers-color-scheme`), full keyboard use, visible focus, WCAG AA contrast.

## 14. Android app

### 14.1 Basics

* Application id `dev.pneumo.app`. minSdk 26. Target and compile SDK: the latest stable. Kotlin 2.x.
* Compose + Material 3 with the brand colour scheme (dynamic colour off).
* Libraries: OkHttp (HTTP and WebSocket), kotlinx.serialization, kotlinx.coroutines, DataStore, Room, WorkManager, CameraX + ZXing core (QR scanning, with no Google Play Services or ML Kit), Coil.
* Manual DI: an `AppContainer` owned by the `Application`.
* Release builds: R8 on, cleartext traffic off. Debug builds allow cleartext to `10.0.2.2` and `localhost`.

### 14.2 Permissions

`INTERNET`, `ACCESS_NETWORK_STATE`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_REMOTE_MESSAGING`, `POST_NOTIFICATIONS`, `RECEIVE_BOOT_COMPLETED`, `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, `CAMERA`.

### 14.3 Pairing and onboarding

1. First launch shows "Pair with your Pneumo server": scan a QR code, open a `pneumo://pair` deep link, or paste the URI.
2. Confirm the host, then claim (§7.5).
3. Onboarding asks for the notification permission (API 33+), then for the battery-optimization exemption, with a plain explanation: "Pneumo keeps a connection open so pushes arrive instantly. Android may cut that connection unless you allow this." Skipping is allowed, with a warning.
4. Start the service and go to Home.

### 14.4 ConnectionService

* A foreground service of type `remoteMessaging`.
* Ongoing notification on channel `connection` (IMPORTANCE_MIN, silent): "Connected to <host>", "Reconnecting…" or "Offline". Tapping it opens the app.
* Started after pairing, on app start, on `BOOT_COMPLETED` and on `MY_PACKAGE_REPLACED`.
* Owns the WebSocket client (§9) and the SyncEngine. Stops only on sign-out or revoke.

### 14.5 SyncEngine

* Keeps `lastPushId` in DataStore and sends it as `since` in hello.
* Applies `push`, `push_deleted` and `device_*` frames to Room.
* On `resync`, pages through `GET /api/pushes` until it overlaps with Room.
* Hands each new push to the PushNotifier exactly once (deduped with a `notified` flag in Room).

### 14.6 PushNotifier

* Channel `pushes` (IMPORTANCE_HIGH).
* Notifies only when the source is not this device and the target is `null` or this device.
* Notification id: a stable hash of the push id. Tag: the push id.
* **note:** title = `payload.title`, or "Note"; BigTextStyle body; action **Copy**.
* **link:** title = `payload.title`, or the URL's host; text = the URL; actions **Open** and **Copy**.
* **file:** title = the file name; text = size plus caption; action **Download**. When the download finishes, the same notification changes to **Open** and **Share**.
* Tapping the notification opens Home, scrolled to that push. The small icon is the brand notification icon.

### 14.7 Actions

* **Copy:** a non-exported `CopyReceiver`, through `PendingIntent.getBroadcast` with `FLAG_IMMUTABLE`. It calls `ClipboardManager.setPrimaryClip(ClipData.newPlainText("Pneumo", text))` and cancels the notification. It shows a "Copied" toast only on API < 33, because Android 13+ shows its own confirmation.
* **Open:** `ACTION_VIEW` on the URL, through `PendingIntent.getActivity`.
* The decrypted text travels in the intent extras; it is not fetched again.

### 14.8 Sending

* **Home composer:** text, link detection, attach through the system picker, target picker.
* **ShareActivity** (exported, shown as a bottom sheet):
  * `ACTION_SEND` with `text/plain`: `EXTRA_TEXT` is the body and `EXTRA_SUBJECT` the title. A single URL becomes a link.
  * `ACTION_SEND` with `image/*` or `*/*` (`EXTRA_STREAM`).
  * `ACTION_SEND_MULTIPLE`: one file push per file.
  * The user picks a target and optionally adds a message. The activity enqueues the work and finishes within 1 second.
* Files go through WorkManager (`UploadWorker`, expedited where allowed, progress notification on channel `transfers`).

### 14.9 Receiving files

* `DownloadWorker` streams the GET, decrypts it (§6.6) and writes to `MediaStore.Downloads` under `Pneumo/<name>` on API 29+, or to the app-specific external Downloads directory on API 26–28.
* It then updates the notification to **Open** (`ACTION_VIEW` with the content URI and `FLAG_GRANT_READ_URI_PERMISSION`) and **Share**.
* On a tag failure it deletes the partial file and shows "This file was corrupted or tampered with."

### 14.10 Screens

Pair, Confirm, Onboarding, Home (history and composer), Devices (list, rename, remove other devices), Settings (connection status, notification permission status, battery exemption status, server host, version, sign out). Every screen and state has a `@Preview` with fixture data.

### 14.11 Crypto

`dev.pneumo.app.crypto` implements §6 with javax.crypto (`PBKDF2WithHmacSHA256`, `HmacSHA256` for HKDF, `AES/GCM/NoPadding`). It must pass `vectors/v1.json`. A Gradle task copies that file, and the protocol fixtures, from `packages/` into the test resources.

## 15. Brand

* **Concept:** retro pneumatic-tube office mail: a capsule zipping through a tube between your devices. Tactile and confident, a little playful. **No medical cues** (lungs, crosses, clinical teal), because the name already leans that way.
* **Deliverables in** `brand/`**:**
  * `mark.svg` (legible at 16 px), `wordmark.svg`, `lockup.svg` (horizontal).
  * Android adaptive icon sources: foreground, background and monochrome layers.
  * Notification icon: 24 dp, single-colour silhouette, as an Android vector drawable.
  * `favicon.svg` and `favicon.ico`; PWA icons 192, 512 and maskable 512; `apple-touch-icon` 180.
  * `og-image` 1200×630 for the README.
* **Palette:** light and dark token sets. Text contrast at least 4.5:1, UI element contrast at least 3:1. `DESIGN.md` includes a contrast table.
* **Type:** one display face for the wordmark and headings, and one UI face. Open licenses (OFL). Self-hosted woff2 on the web. `DESIGN.md` decides whether Android bundles the UI face or uses the system font.
* **Generation:** `brand/tokens.json` is the source. `mise run brand:export` generates `apps/web/src/styles/tokens.css`, `apps/android/app/src/main/java/dev/pneumo/app/ui/theme/BrandColors.kt`, and the PNG exports from the SVGs. The export must be reproducible.
* **Process:** a directions issue produces 3 directions on one review page → the owner picks one (needs-human) → a finalize issue produces everything above.

## 16. Deploy and release

### 16.1 Docker

* Multi-stage `Dockerfile` at the repo root:
  1. pnpm install.
  2. Build the packages, the web app and the server.
  3. Runtime on `node:26-slim` as the non-root user `pneumo`, with only the server dist, the web dist and production dependencies.
* Image size at most 250 MB. `EXPOSE 8080`. `CMD ["node", "apps/server/dist/index.js"]`.

### 16.2 Local development

* `docker-compose.yml`: `minio`, plus `minio-init`, which creates the bucket `pneumo` and allows CORS for local origins through `MINIO_API_CORS_ALLOW_ORIGIN`. An optional `server` profile adds the server.
* `.env.example` holds dev values (fake credentials such as `minioadmin`, `UPLOAD_MODE=direct`, `PNEUMO_SETUP_TOKEN=dev-setup-token`). mise loads `.env.local`, which is gitignored.

### 16.3 Railway (owner)

* Project `pneumo`, with a Bucket `pneumo-files` in the region closest to the owner.
* Service `pneumo`, built from the GitHub mirror's Dockerfile (Railway can't deploy from Tangled). The mirror's `main` moves only on releases, so production redeploys only on releases.
* Variables per §12.3, using bucket references. Healthcheck `/api/health`. Replicas 1. A public domain.
* Railway deploy settings are applied through Infrastructure as Code by the lead and set in the template, not read from `railway.json`; see [ADR 0001](adr/0001-railway-deploy-config.md).
* A `staging` environment, which gets its own bucket instance, is used for smoke and deploy-overlap tests, so the production instance stays uninitialized until the owner sets it up.

### 16.4 Tangled, CI and the GitHub mirror

* **Repo:** `tangled.org/demi.dev/pneumo`, remote `demi.dev@tangled.org:did:plc:qzsds2tco6vi45xxqy4uk5cx` (served by the knot `knot1.tangled.sh`). All changes reach `main` through pull requests, except the two M0 bootstrap issues.
* **CI** (Tangled hosted spindle): workflows in `.tangled/workflows/*.yml`, triggered on `push` to `main` and on `pull_request` to `main`. Lane checks run in CI. e2e lanes run in CI only where the hosted spindle's engines and time limits allow (for example the `microvm` engine for Docker). `docs/agents/tangled.md` lists what is local-only.
* **GitHub mirror:** `github.com/stoopkidddd/pneumo`, public and read-only (issues, PRs and wiki off; the README says contributions go to Tangled). `mise run release` pushes `main` and the release tag to it, so its `main` always equals the latest release.
* **Release** (`mise run release <version>`, run on the owner's Mac):
  * build and push `ghcr.io/stoopkidddd/pneumo:{version,latest}` for linux/amd64 and arm64 (no `latest` for `-rc` versions);
  * build the signed release APK `pneumo-<version>.apk` and `SHA256SUMS`;
  * tag on Tangled, push `main` + the tag to the mirror, and create the GitHub Release on the mirror with `gh`.

### 16.5 APK signing

* The release keystore is made once with keytool and kept outside the repo: `~/.config/pneumo/release.jks` (mode 600), with its passwords in `~/.config/pneumo/release.env` (mode 600).
* It never leaves the Mac: releases are built locally by `mise run release`, so no CI system holds it. The Gradle release signingConfig reads its path and passwords from env vars that the release task loads from `~/.config/pneumo/release.env`.
* The owner must back up `~/.config/pneumo/`. If the keystore is lost, users must uninstall the app to update it.

### 16.6 Railway template

* Made from the deployed project (`railway templates create`, or the dashboard's "Generate Template").
* Service source: the GitHub mirror (Railway can't deploy from Tangled). The bucket is included. S3\_\* use bucket references.
* No `PNEUMO_SETUP_TOKEN`: the server generates one and logs the setup URL.
* The README has a "Deploy on Railway" button.

### 16.7 Other hosts

The README explains how to run the GHCR image with any S3-compatible store (Cloudflare R2, Backblaze B2, AWS S3, MinIO), including the env table and CORS notes.

### 16.8 Versioning

Semver. The server reports its version from `package.json`. The Android `versionName` matches. `versionCode` = `major·10000 + minor·100 + patch`.

## 17. Testing strategy

* **Contract:** the server validates with the `@pneumo/protocol` schemas, and the web client uses them. `packages/protocol/fixtures/*.json` (generated: one valid example of every DTO and frame, plus some invalid ones) are parsed by the Kotlin tests.
* **Crypto:** the vectors (§6.10) run in TS and in Kotlin. A Python stdlib script cross-checks the KDF, HKDF, keyCheck and authKey sections. fast-check round-trip properties run in TS.
* **Server:** unit tests (fake Storage, fake clock), route tests through `app.request()`, WebSocket tests with real sockets, and MinIO integration tests (`e2e:server`).
* **Web:** vitest + Testing Library. Playwright e2e against the real server and MinIO. axe checks. Screenshots for review.
* **Android:** JVM tests and Robolectric. Roborazzi screenshots from previews. Gradle Managed Device smoke tests (`e2e:android`) against a local server.
* **Dev client** (`scripts/pneumo-dev.ts`): setup, login, pairing, claim, send, listen and smoke from the command line, with real crypto. Used by the e2e harnesses, the gates and the staging smoke tests.
* **e2e harness:** each e2e task starts its own MinIO container (unique name, random host port) and its own server (random port), so worktrees can run e2e in parallel. Where Docker isn't available (Tangled `nixery` CI steps), the harness runs the native `minio` binary instead (`PNEUMO_E2E_MINIO=native`). `e2e:android` runs one at a time, because of the emulator.

## 18. Verify at implementation time

1. Railway Buckets (Tigris) accept `PutBucketCors` and presigned PUTs with a signed Content-Length. If not, use proxy mode (already specified). Check this in the staging deploy.
2. Railway deploy overlap: confirm that the 30-second re-list (§12.2) catches pushes written by the old instance. Overlap and draining are Railway service settings applied per [ADR 0001](adr/0001-railway-deploy-config.md).
3. The `remoteMessaging` foreground-service type works on Android 14–16 at the latest targetSdk, and the owner's phone does not kill it (real-device soak in M5).
4. WebCrypto in service workers, and storing a `CryptoKey` in IndexedDB, on current Chrome and Firefox.
5. Node 26: compile to `dist` by default rather than relying on type stripping in production.
6. Web Push payload limits on Chrome and Firefox (we cut off at 3,000 bytes).
7. Tangled's hosted spindle: which engines it offers (`nixery`, `microvm`), its workflow timeout (the documented default is 5 minutes), and whether PR pages show pipeline status. This decides which lanes run in CI.
8. Pull requests created with the `tang` CLI get indexed by the AppView (a past bug: [tangled.org/core#576](<http://tangled.org/core#576>)), and how to resubmit a new round from the CLI. Fallback: the web form through browser automation.

## 19. Phase 2 (not in the MVP)

* Browser extension (MV3, Chrome + Firefox).
* Tauri tray app (macOS/Linux) with notifications and Copy.
* Optional FCM wake-ups for battery life.
* Mirroring Android notifications to the browser.
* Passphrase change and key rotation.
* Multipart uploads over 500 MiB.
* Android login with the passphrase (no QR).
* Auto-download of small files on Wi-Fi.
* Image thumbnails in notifications.
* Dismiss sync.
* History search.
* Index compaction past about 20,000 pushes.
