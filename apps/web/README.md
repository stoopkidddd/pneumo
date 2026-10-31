# Web app shell

The React app uses the generated Switchboard tokens, bundled Chivo and Public Sans fonts, and the approved brand vectors. Theme follows `prefers-color-scheme`; keyboard controls use the brand focus ring. Home and Devices are route shells only in ENG-252.

Internal links use `Link` to push browser history without reloading the document or re-running session bootstrap. Back and Forward update the route through `popstate`; guard redirects replace the current history entry. Modified clicks, new-tab targets, downloads, and external links retain native browser behavior.

## Authentication and storage

- Startup reads `/api/health`. An uninitialized instance opens `/setup`; an initialized, signed-out browser opens `/login`. A saved session is checked with `/api/me` before opening protected routes.
- Open the server-provided setup link with its `#token=` fragment. The app captures the token and removes the fragment from browser history. Setup checks at least 12 NFC-normalized Unicode characters and a matching normalized confirmation.
- All derivation uses `@pneumo/crypto`. The passphrase stays local. Setup generates the protocol KDF parameters; login fetches the existing parameters. Derivation disables the form and announces its busy state.
- Setup keeps the new session in memory until the owner acknowledges the recovery warning. Acknowledgment saves it and opens Home.
- `src/session/store.ts` exports `Session`, `load`, `save`, and `clear`. IndexedDB database `pneumo`, store `session`, key `current` holds `{ deviceId, token, mk, contentKey }`. MK is raw bytes for future pairing; the content key is a structured-cloned, non-extractable AES-GCM `CryptoKey`. Writes finish only after transaction commit.
- Settings deletes the current device before clearing the local session. A server 401 clears the session and opens login; wrong-passphrase login failures keep their specific message. Rate-limit messages round `Retry-After` seconds up to minutes.

## API client

`src/api/client.ts` exports `ApiClient`, `ApiError`, and `createApiClient({ onUnauthorized })`. Create one client for the shell and supply its async signed-out navigation callback. Route names, request bodies, path parameters, query input, and responses derive from the frozen `@pneumo/protocol` table; no parallel endpoint map is maintained.

```ts
const health = await api.request("health");
const me = await api.request("me");
await api.request("deleteDevice", { params: { id: me.device.id } });
```

Bearer routes read the current IndexedDB session. Request and response JSON use the protocol schemas. Binary routes bypass JSON; 204 responses return `undefined`; WebSocket upgrades are not HTTP client routes. `ApiError` exposes `status`, protocol `code`, `message`, and `retryAfterSeconds`.

## Development and verification

Run from the repository root with pinned mise tools:

```sh
mise run dev:web
mise run check:web
mise exec -- pnpm --filter @pneumo/web exec playwright install chromium
mise run e2e:web
```

Vite proxies `/api` and `/api/ws` to `localhost:8080`. Production serves `dist` through the Hono server with its real CSP.

Playwright global setup builds both apps, starts isolated MinIO through `scripts/e2e/minio.ts`, and starts the built server on an OS-assigned port with direct uploads and the web build directory. Each fresh-instance fixture gets another random-port server and unique S3 prefix; signed-in fixtures complete real setup in an isolated browser context. No test depends on ports 8080 or 9000. Teardown stops the owned server processes and MinIO. The harness supports macOS and Linux port discovery, and the shared MinIO helper supports Docker or native MinIO.

The suite covers setup acknowledgment, second-browser login, persisted-key decryption after reload, sign-out/re-login, wrong passphrases, missing setup tokens, rate limits, revocation, client-side navigation with Back/Forward and no bootstrap requests, connection-failure recovery, and axe scans of each view. Component tests cover sign-out ordering and failure branches, plus authentication errors including exact `Retry-After` rounding (120 seconds → 2 minutes; 121 seconds → 3 minutes). Light/dark captures are saved under `test-results/screens/` for setup, missing-token setup, login, recovery warning, Home, Devices, Settings, and Connection unavailable, plus mobile captures of setup and login states. Screenshots are not committed. Traces, video, and automatic failure screenshots are disabled so credentials and session state do not enter artifacts.
