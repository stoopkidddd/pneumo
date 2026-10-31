# @pneumo/protocol

Shared contract for the server, web app, service worker and Android fixture tests.
The normative shapes are in `docs/SPEC.md` §§5–6, 8–9, 11 and 12.3. This package
implements no HTTP transport, WebSocket transport or encryption.

Every schema below also exports a same-name TypeScript type inferred with
`z.infer`. Object schemas strip unknown fields, including nested objects.

## Exported API

| Export                                                                                                                                                                      | Contract                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `B64u`                                                                                                                                                                      | Canonical unpadded base64url, including zero unused bits; the empty byte string is valid.                                                                                                    |
| `Uuidv7`, `IsoTimestamp`, `HttpUrl`                                                                                                                                         | Lowercase canonical UUIDv7; UTC timestamp with exactly three fractional digits; absolute HTTP(S) URL without whitespace.                                                                     |
| `KdfParams`                                                                                                                                                                 | PBKDF2-SHA256 algorithm, positive safe-integer iterations and 16-byte salt. The schema accepts stored iteration counts, not only the setup default.                                          |
| `Envelope`                                                                                                                                                                  | Version 1, 12-byte nonce `n`, ciphertext `c` containing at least the 16-byte GCM tag.                                                                                                        |
| `NotePayload`, `LinkPayload`, `FilePayload`, `PushPayload`                                                                                                                  | Plaintext note/link/file shapes and their `type`-discriminated union. File size is plaintext bytes; file key is 32 bytes. Never send these payloads unencrypted.                             |
| `Platform`                                                                                                                                                                  | `web`, `android`, `desktop`, `cli`.                                                                                                                                                          |
| `WebPushSubscription`                                                                                                                                                       | HTTP(S) endpoint and b64u P-256 public key (65 bytes) and auth secret (16 bytes).                                                                                                            |
| `DeviceInput`                                                                                                                                                               | Device registration `{ name, platform }`.                                                                                                                                                    |
| `DeviceRecord`, `DeviceDTO`                                                                                                                                                 | Persisted versioned record with token hash/subscription; public device with `online` and no credentials/subscription/version.                                                                |
| `PushRecord`, `PushDTO`                                                                                                                                                     | Persisted versioned record; public push without `v`. Nullable target and file are required fields; persisted file size is ciphertext bytes.                                                  |
| `Limits`, `UploadMode`                                                                                                                                                      | Configured byte limits; `auto`, `direct`, `proxy`. `/api/me` uses the same upload-mode enum.                                                                                                 |
| `ErrorCode`, `ErrorBody`, `ERROR_STATUS`                                                                                                                                    | All ten normative error codes; `{ error: { code, message } }`; code-to-HTTP-status map.                                                                                                      |
| `HealthResponse`                                                                                                                                                            | Health result with literal `ok: true`, version and initialization state.                                                                                                                     |
| `SetupRequest`, `SetupResponse`                                                                                                                                             | Setup credential/KDF/device registration; resulting public device and 32-byte token. Setup tokens are nonempty strings because the environment may supply one.                               |
| `AuthParamsResponse`, `LoginRequest`, `LoginResponse`                                                                                                                       | Public KDF parameters; auth key/device registration; resulting public device and token.                                                                                                      |
| `MeResponse`                                                                                                                                                                | Current device, key check, limits, VAPID public key and upload mode.                                                                                                                         |
| `ListDevicesResponse`, `UpdateDeviceRequest`, `SubscribeWebPushRequest`                                                                                                     | Device list, rename and Web Push subscription bodies. Rename responds with `DeviceDTO`.                                                                                                      |
| `CreatePairResponse`, `ClaimPairRequest`, `ClaimPairResponse`                                                                                                               | 16-byte pairing code and expiry; code/device claim; resulting public device and token.                                                                                                       |
| `CreateFileRequest`, `CreateFileResponse`, `GetFileResponse`                                                                                                                | Ciphertext size reservation; PUT URL/method/headers and expiry; download URL/headers and expiry. Transfer URLs may be HTTP(S) URLs or same-origin absolute paths for proxy mode.             |
| `CreatePushRequest`, `ListPushesQuery`, `ListPushesResponse`                                                                                                                | Push submission; optional `before` push id and integer limit (1–100, default 50); push page and required nullable `nextBefore` push id. Create/get push responses use `PushDTO`.             |
| `HelloFrame`, `PongFrame`, `ClientFrame`                                                                                                                                    | Individual client frames and their `type`-discriminated union. `since` is a required nullable push id.                                                                                       |
| `ReadyFrame`, `PushFrame`, `PushDeletedFrame`, `DeviceAddedFrame`, `DeviceUpdatedFrame`, `DeviceRemovedFrame`, `ReplayDoneFrame`, `ResyncFrame`, `PingFrame`, `ServerFrame` | Individual server frames and their `type`-discriminated union.                                                                                                                               |
| `jsonSchemas`                                                                                                                                                               | Registry of every exported JSON schema, keyed by its export name; used for fixture coverage.                                                                                                 |
| `routes`, `Route`                                                                                                                                                           | Readonly literal table of all 21 HTTP routes; route descriptor type. See response/transport conventions below.                                                                               |
| `HKDF_LABELS`                                                                                                                                                               | `contentKey`, `authKey`, `checkKey` labels from §6.2.                                                                                                                                        |
| `KEY_CHECK_LABEL`, `PUSH_AAD_PREFIX`, `FILE_AAD_PREFIX`                                                                                                                     | Key-check message and AAD prefixes from §§6.3, 6.5–6.6.                                                                                                                                      |
| `FILE_HEADER`, `FILE_CHUNK_SIZE`                                                                                                                                            | Readonly eight-byte `PNMF` v1 header tuple; 65,536-byte plaintext chunks. Use `new Uint8Array(FILE_HEADER)` when bytes are needed.                                                           |
| `DEFAULT_LIMITS`                                                                                                                                                            | Ciphertext file limit 524,288,000 bytes; serialized envelope limit 65,536 UTF-8 bytes.                                                                                                       |
| `DEFAULT_KDF_ITERATIONS`, `DEFAULT_UPLOAD_MODE`, `DEFAULT_WS_PING_SECONDS`                                                                                                  | 600,000; `auto`; 60 seconds.                                                                                                                                                                 |
| `WS_HELLO_TIMEOUT_MS`, `WS_CLOSE_CODES`                                                                                                                                     | 10,000 milliseconds; `protocolError: 4400`, `unauthorized: 4401`, `restarting: 1012`.                                                                                                        |
| `MAX_OBJECT_TIMESTAMP_MS`                                                                                                                                                   | 9,999,999,999,999, the reverse-timestamp key domain maximum.                                                                                                                                 |
| `uuidv7()`, `isUuidv7(value)`                                                                                                                                               | Generate an RFC 9562 UUIDv7 with WebCrypto randomness; check an unknown value with a string type guard. No same-millisecond monotonicity guarantee.                                          |
| `pushObjectKey(createdAtMs, id)`, `parsePushObjectKey(key)`                                                                                                                 | Format `pushes/<13-digit invTs>_<id>.json`; parse to `{ createdAtMs, id }` or `null`. Keys are relative to the optional S3 prefix. Invalid generation inputs throw `TypeError`/`RangeError`. |
| `detectLink(text)`                                                                                                                                                          | Boolean: trimmed text is exactly one valid HTTP(S) URL. The caller uses `text.trim()` for the link URL; internal whitespace or multiple lines of content produce a note.                     |
| `ciphertextSize(plainSize)`                                                                                                                                                 | `8 + plainSize + 16 * max(1, ceil(plainSize / 65536))`. Zero plaintext bytes produce 24 ciphertext bytes. Rejects negative, fractional or unsafe sizes/results.                              |

## Route descriptors

`routes` preserves each literal `name`, `method`, `path` and `auth`. JSON
`request`/`response` values are Zod schemas. No request body means `request` is
omitted. `response: null` means no response body (204), `"bytes"` means a binary
body/stream, and `"websocket"` means a WebSocket upgrade. The WebSocket row's
`frames.client` and `frames.server` expose all §9 frame schemas through their
unions. No extra HTTP routes are invented for frames.

`success` lists the success status codes, including both 201 and idempotent 200
for `createPush`. `errors` lists applicable error codes; `ERROR_STATUS` supplies
their status codes and `ErrorBody` supplies the JSON body schema. Setup and pair
credentials are in their request bodies. The WebSocket upgrade has `auth: "none"`
because authentication occurs in `HelloFrame`, not in the HTTP upgrade.

`listPushes.query` validates normalized query values (numeric `limit`); the HTTP
adapter must decode URL query strings before validation. The spec leaves cursor
encoding unspecified: this contract uses UUIDv7 push ids for `before` and
`nextBefore`, consistent with WebSocket `since`. File ids also use UUIDv7.

File/envelope maxima are deployment-configurable. Schemas validate shape and
byte counts without hardcoding the default maxima; the server must enforce its
configured limits, measure serialized envelopes in UTF-8 bytes, and return 413.

## Fixtures and verification

Install from the workspace root with `mise exec -- pnpm install --frozen-lockfile`.
The workspace `allowBuilds` policy approves only `esbuild`, required by the
`tsx` fixture runner; other dependency build scripts remain unapproved.

```sh
pnpm --filter @pneumo/protocol fixtures:generate
mise run check:protocol
```

`src/fixtures.ts` builds all fixture files in memory without filesystem access;
`scripts/generate-fixtures.ts` writes them under `fixtures/valid` and
`fixtures/invalid`, removing obsolete generated files. Fixture generation uses
fixed fake values, not randomness, clocks or real credentials. It does not
perform encryption and is not a source of cryptographic test vectors.

Valid files contain the raw JSON value, with one or more examples per schema and
every payload/frame union branch. Invalid filenames identify the schema and the
rule violated, with at least two failures per schema. The fixture tests validate
those outcomes and compare the complete generated file set byte-for-byte with
the committed files, so `check:protocol` fails on stale, missing or extra files
with an instruction to run `fixtures:generate`.
