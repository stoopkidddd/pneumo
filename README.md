# Pneumo

Pneumo is a self-hosted, end-to-end encrypted replacement for the core of Pushbullet. Send notes, links and files between your own browser and Android phone and get instant notifications. Each deployment has one user and runs as one small server plus any S3-compatible bucket; the server never sees your passphrase, your keys or any plaintext.

**Status:** in development. The design is in [`docs/SPEC.md`](docs/SPEC.md).

Source, pull requests and CI live on Tangled: [tangled.org/demi.dev/pneumo](https://tangled.org/demi.dev/pneumo).

## Development

Install the pinned tools with [mise](https://mise.jdx.dev/), then install the workspace dependencies:

```sh
mise install
mise exec -- pnpm install --frozen-lockfile
```

The TypeScript workspace contains `@pneumo/protocol`, `@pneumo/crypto`, `@pneumo/server` and
`@pneumo/web`. The shared packages expose TypeScript source to workspace consumers. The server's
tsup build bundles `@pneumo/*` packages into its ESM entrypoint; npm dependencies stay external so
plain Node can run the output without a TypeScript loader.

```sh
mise run check:protocol  # Biome, TypeScript and Vitest for protocol and crypto
mise run check:server    # Biome, TypeScript and Vitest for the server
mise run check:web       # Biome, TypeScript, Vitest and a Vite production build
mise run android:setup   # Configure the local SDK path on a fresh checkout
mise run check           # All implemented lanes, including Android
mise run fmt             # Format TS packages and root config; exclude Android, brand and generated files
```

`mise exec -- pnpm test` runs all four Vitest projects. Start the minimal web app with
`mise exec -- pnpm --filter @pneumo/web dev`.

Copy `.env.example` to `.env.local`, start the development bucket with `mise run dev:infra`,
then run `mise exec -- pnpm --filter @pneumo/server dev` for the server watcher.
For a production-style local run:

```sh
mise exec -- pnpm --filter @pneumo/web build
mise exec -- pnpm --filter @pneumo/server build
mise exec -- node --env-file=.env.local apps/server/dist/index.js
```

The server serves the built web app and `GET /api/health`. `WEB_DIST_DIR` defaults to
`apps/web/dist`, resolved relative to the server rather than the current directory. Before
listening, the server loads `meta/owner.json`, the device registry, and the VAPID keypair
from the bucket. Health reports the package version and whether the owner record exists.

First-run setup uses `PNEUMO_SETUP_TOKEN` when configured. Otherwise startup logs one
warning containing the setup URL and its token fragment, only while uninitialized.
`POST /api/setup` conditionally creates the owner record and registers the first device;
subsequent attempts return 409. The server receives derived authentication material,
never the passphrase, and stores a salted scrypt verifier.

Login creates a device with a bearer token; only its SHA-256 hash is persisted.
Authentication failures are limited to five per IP and thirty globally per fifteen minutes.
`TRUST_PROXY` controls whether the first `X-Forwarded-For` address identifies the client.
Authenticated clients can list, rename and revoke devices, store or clear their own Web Push
subscription, and issue single-use ten-minute Android pairing codes. Revocation invalidates
the token immediately and signals socket closure for the later WebSocket hub.
`GET /api/me` returns the key check, resolved upload mode, and the 65-byte base64url VAPID
public key. Device DTOs never expose token hashes or subscriptions.

When `meta/vapid.json` is missing, startup generates a P-256 VAPID keypair and persists
`{ publicKey, privateKey, subject }`. The subject is `VAPID_SUBJECT`, defaulting to `PUBLIC_URL`.
Later boots reuse the stored record. The private key is never returned by the API and is
redacted from structured logs. Web Push sending is not implemented yet.

Server bucket access uses the `Storage` contract in `apps/server/src/storage/types.ts`.
`S3Storage` is used at runtime; tests use `MemoryStorage` or an isolated MinIO instance.
`S3_PREFIX` is a namespace: a nonempty value gets a trailing `/` if needed, and callers
always use unprefixed keys. Listing is UTF-8 lexicographic; `maxKeys` controls page size,
not the total number of results. Missing reads throw `StorageError` with code `NotFound`;
missing heads return `null`. Conditional JSON creates use `{ ifNoneMatch: "*" }`.

With `UPLOAD_MODE=auto`, startup applies and reads bucket CORS. Both calls must succeed
to select direct uploads; otherwise one warning records the operation and safe error code,
and uploads use proxy mode. A briefly missing bucket is retried for about ten seconds so
`minio-init` can finish; other failures fall back immediately. Explicit `direct`/`proxy`
skip detection. CSP includes the bucket origin only in the resolved direct mode.

Storage and authentication route tests use memory and fake clocks in `check:server`
(no Docker). Run the MinIO storage, setup/device/VAPID persistence, and bundled HTTP lifecycle
integration tests with:

```sh
mise exec -- pnpm --filter @pneumo/server test:e2e
```

The integration runner starts and stops its own uniquely named MinIO container and creates
the bucket. Set `PNEUMO_E2E_MINIO=native` to use installed `minio`/`mc` binaries instead.
The pinned MinIO build provides global CORS via `MINIO_API_CORS_ALLOW_ORIGIN` but reports
bucket `PutBucketCors` as unsupported, so auto detection selects proxy mode. Forced direct
mode still permits signed PUT/GET when bucket CORS is configured externally.

`check:server` also checks bundled startup's safe config failures. The MinIO integration
suite launches the bundle with plain Node, an ephemeral port, and a temporary web fixture.
It exercises setup, authentication, pairing, restart persistence, HTML serving, and SIGTERM
shutdown. The shutdown hook list in `src/index.ts` is the registration point for the later
WebSocket hub; hooks receive close code 1012, with a ten-second drain deadline.
Storage sockets remain open during the drain; process exit releases them afterward.

The injected `Clock.now()` returns Unix epoch milliseconds, matching `Date.now()`. Tests use
epoch-millisecond fake clocks so timestamps and expiry calculations share the production unit.
Request log durations are differences between clock readings, clamped to zero on backward jumps.

License: MIT.
