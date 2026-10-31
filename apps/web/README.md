# Web app shell

The React app uses the generated Switchboard tokens, bundled Chivo and Public Sans fonts, and the approved brand vectors. Theme follows `prefers-color-scheme`; keyboard controls use the brand focus ring. Home supports encrypted notes and links. Devices lists and manages paired devices and adds phones through a pairing QR code.

Internal links use `Link` to push browser history without reloading the document or re-running session bootstrap. Back and Forward update the route through `popstate`; guard redirects replace the current history entry. Modified clicks, new-tab targets, downloads, and external links retain native browser behavior.

## Authentication and storage

- Startup reads `/api/health`. An uninitialized instance opens `/setup`; an initialized, signed-out browser opens `/login`. A saved session is checked with `/api/me` before opening protected routes.
- Open the server-provided setup link with its `#token=` fragment. The app captures the token and removes the fragment from browser history. Setup checks at least 12 NFC-normalized Unicode characters and a matching normalized confirmation.
- All derivation uses `@pneumo/crypto`. The passphrase stays local. Setup generates the protocol KDF parameters; login fetches the existing parameters. Derivation disables the form and announces its busy state.
- Setup keeps the new session in memory until the owner acknowledges the recovery warning. Acknowledgment saves it and opens Home.
- `src/session/store.ts` exports `Session`, `load`, `save`, and `clear`. IndexedDB database `pneumo`, store `session`, key `current` holds `{ deviceId, token, mk, contentKey }`. MK is raw bytes for pairing QR generation; the content key is a structured-cloned, non-extractable AES-GCM `CryptoKey`. Writes finish only after transaction commit.
- Settings deletes the current device before clearing the local session. A server 401 clears the session and opens login; wrong-passphrase login failures keep their specific message. Rate-limit messages round `Retry-After` seconds up to minutes.

## Home and live history

- The auto-growing composer sends on Enter; Shift+Enter adds a line and IME composition does not send. Focus returns to Message after success or failure, so typing can continue without tabbing back into the form. A single HTTP(S) URL uses the frozen `detectLink` helper. Titles are optional, and the target picker lists all devices with explicit presence labels.
- `/api/me` supplies the envelope limit. The composer counts UTF-8 payload JSON, the GCM tag, base64url expansion, and envelope JSON before enabling Send. UUIDv7 ids and encryption use `@pneumo/protocol` and `@pneumo/crypto`. Only ciphertext goes to the server.
- A send inserts an optimistic row, reconciles HTTP/WebSocket echoes by id, and restores the draft if sending fails. History sorts by server `createdAt`, then id. Infinite scroll has a keyboard-accessible “Load older pushes” fallback. Failed decryption affects only its row.
- Copy uses the note body or link URL. Links open in a separate tab with `noopener noreferrer`. Delete confirms inline. Long bodies expand in place. `/?push=<id>` fetches an item outside the current page, highlights it, and focuses Copy.
- `src/live/ws.ts` stays connected across protected routes. It validates protocol frames, replies to ping, watches 135 seconds of silence, and reconnects with full jitter or immediately on network/visibility restoration. A 4401 close clears the session and opens login with a message.
- The cursor advances synchronously for each received push, before decryption. Resync replaces the current page while retaining pending sends and live arrivals; deletion tombstones reject delayed results. Reconnection also refreshes history and devices to catch missed deletions and presence changes.
- Offline mode retains already loaded history in memory; it does not queue sends or persist a history cache. HTTP failures offer an inline retry. Files, PWA, and notifications remain outside this issue.

## Devices and phone pairing

- `/devices` shows platform icons, the current-browser badge, online/offline status, and relative last-seen times. Rename and confirmed removal happen inline. Settings uses the same name editor for this browser. Removing this browser revokes its device and clears local keys, just like signing out.
- `useHome` already lives in the shell across protected routes; Devices and Settings reuse its device list and its single WebSocket. The device reducer merges `device_added`, `device_updated`, and `device_removed` frames without allowing an in-flight list response to undo newer changes.
- A remotely revoked browser receives 4401 and opens `/login` with “This browser was removed from Pneumo.” Intentional removal and sign-out keep the ordinary signed-out message.
- **Add a phone** requests a single-use, ten-minute code and passes the current origin, code, and session MK to `buildPairingUri`. `qrcode` draws it on a canvas with error correction M. The URI never enters DOM text, attributes, links, the clipboard, or logs.
- The modal counts down to the server's expiry. **New code** immediately wipes the previous QR; expiry hides and wipes it too. Close and Escape return focus to **Add a phone**. A `device_added` frame created after the active code closes the modal and highlights the new row; list refreshes and presence updates do not complete pairing. Creation time comes from the server expiry minus ten minutes, avoiding client/server clock differences in event ordering.
- Vitest covers device-event reconciliation, name-edit recovery, countdown, expiry, regeneration, and stale async responses. Playwright decodes the actual canvas with `jsQR`, verifies its origin and MK in memory, and claims the code through the real API. It also covers rename persistence, cross-browser revocation, self-removal, focus restoration, and axe scans.

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

The suite covers setup, second-browser login, persisted-key decryption, sign-out/re-login, authentication failures, revocation, client-side Back/Forward, connection recovery, and axe scans. Home adds real two-context delivery within two seconds, targeted pushes in both histories, clipboard/Open actions, inline deletion, encrypted-size limits, draft recovery, keyboard focus after sending, decryption failures, pagination, and deep-link focus. The offline replay test closes both sides of a real WebSocket proxy, checks the replacement hello cursor, and requires the missed push frame between `ready` and `replay_done`; HTTP refresh alone cannot satisfy it. Vitest covers composer interactions, history transitions, and the WebSocket lifecycle with fake sockets and timers.

Light/dark Home captures are `home-{empty,items,offline,error}-{light,dark}.png`, with corresponding `home-{empty,items,offline,error}-mobile.png` captures, under `test-results/screens/`. Keyboard-focus captures preserve Message focus after sending: `home-send-{success,error}-focus-{light,dark}.png` and `home-send-{success,error}-focus-mobile.png`. Existing shell captures remain there too. Screenshots are not committed. Traces, video, and automatic failure screenshots are disabled so credentials and session state do not enter artifacts.

Devices captures are `devices-{list,rename,remove-confirm,pairing,paired,revoked-login,self-removed-login}-{light,dark,mobile}.png`; editable Settings captures are `settings-device-name-{light,dark,mobile}.png`. All are under `test-results/screens/` and remain uncommitted. Pairing captures contain only throwaway test-instance QR images, never the raw URI.
