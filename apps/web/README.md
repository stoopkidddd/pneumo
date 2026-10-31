# Web app shell

The React app uses the generated Switchboard tokens, bundled Chivo and Public Sans fonts, and the approved brand vectors. Theme follows `prefers-color-scheme`; keyboard controls use the brand focus ring. Home supports encrypted notes, links, and files. Devices lists and manages paired devices and adds phones through a pairing QR code.

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
- Offline mode retains already loaded history in memory; it does not queue sends or persist a history cache. HTTP failures offer an inline retry. An offline reload opens the precached shell with the stored session and the offline banner; history reloads after reconnection.

## Encrypted files

- **Attach** opens a multiple-file picker. The picker, drop overlay, and file paste stay unavailable until the session and both `/api/me` limits are loaded, while offline, and during a pending message send. Blocked drops cannot navigate away or discard the draft. Once ready, dropping files anywhere on Home or pasting files/images sends immediately, one push per file, to the selected target. The current message and optional title accompany only the first file.
- Empty or whitespace-only file titles and captions are omitted, so receiving clients can fall back to “New file” and the filename. Nonblank text keeps its original content; later files in a selection omit both optional fields.
- Before reserving any file in a selection, the client compares `ciphertextSize(file.size)` with `/api/me`'s `limits.maxFileBytes` and checks the encrypted metadata envelope. A rejected selection keeps the draft and names the instance limit.
- A fresh file key encrypts `file.stream()` through `createFileEncryptor` into a Blob. XMLHttpRequest PUT progress appears in History. Direct mode uses the returned presigned URL and signed headers; proxy mode uses the same-origin content route with bearer auth. The browser supplies Content-Length from the Blob.
- **Cancel** aborts preparation or the active XHR before push creation. The cancelled row can be dismissed; uploaded or reserved orphan files are left for the server sweep. Once push submission starts, Cancel is no longer offered.
- File rows show the name, plaintext size, and a file/image icon. **Download** fetches the descriptor, reports byte progress, and authenticates the complete stream through `createFileDecryptor` before saving a Blob through an object URL. URLs are revoked after triggering the download. Any integrity failure discards all output and shows “This file was corrupted or tampered with”. File deep links focus Download.
- `startWebRuntime(prefix, { uploadMode, maxFileBytes })` provisions isolated direct/proxy browser test instances without changing the shared Playwright configuration. Both modes cover random-byte round trips at 0 B, 1 B, 65,536 B, and 5 MiB, multiple selection, drop/paste, exact size boundaries, cancellation and Dismiss after native upload progress, and tamper rejection without a saved file. A deliberately held `/api/me` response verifies that file actions remain disabled until limits arrive; ordinary file helpers wait for the enabled picker before selecting or dispatching files.

## Devices and phone pairing

- `/devices` shows platform icons, the current-browser badge, online/offline status, and relative last-seen times. Rename and confirmed removal happen inline. Settings uses the same name editor for this browser. Removing this browser revokes its device and clears local keys, just like signing out.
- `useHome` already lives in the shell across protected routes; Devices and Settings reuse its device list and its single WebSocket. The device reducer merges `device_added`, `device_updated`, and `device_removed` frames without allowing an in-flight list response to undo newer changes.
- A remotely revoked browser receives 4401 and opens `/login` with “This browser was removed from Pneumo.” Intentional removal and sign-out keep the ordinary signed-out message.
- **Add a phone** requests a single-use, ten-minute code and passes the current origin, code, and session MK to `buildPairingUri`. `qrcode` draws it on a canvas with error correction M. The URI never enters DOM text, attributes, links, the clipboard, or logs.
- The modal counts down to the server's expiry. **New code** immediately wipes the previous QR; expiry hides and wipes it too. Close and Escape return focus to **Add a phone**. A `device_added` frame created after the active code closes the modal and highlights the new row; list refreshes and presence updates do not complete pairing. Creation time comes from the server expiry minus ten minutes, avoiding client/server clock differences in event ordering.
- Vitest covers device-event reconciliation, name-edit recovery, countdown, expiry, regeneration, and stale async responses. Devices component tests cover current-browser ordering, removal confirmation/cancellation and focus restoration, failed-removal recovery, and self-removal routing. Playwright decodes the actual canvas with `jsQR`, verifies its origin and MK in memory, and claims the code through the real API. It also covers rename persistence, cross-browser revocation, self-removal, focus restoration, and axe scans.

## Installation and browser notifications

- The production build uses `vite-plugin-pwa` in `injectManifest` mode. `/manifest.webmanifest` declares standalone launch, the brand colors, and the 192/512/maskable icons. `/sw.js` precaches the shell, bundled fonts, and public brand assets. Navigation falls back to the shell, excluding `/api`; API responses and decrypted history are never cached.
- Settings → **Browser notifications** requests permission, subscribes with `/api/me`'s VAPID public key, and saves the subscription through `PUT /api/devices/self/webpush`. Turning it off deletes the server subscription and unsubscribes locally. Sign-out and self-removal also unsubscribe. Blocked permission and unsupported browsers have explicit disabled states.
- Home offers **Get notified in this browser** after setup/login when permission is undecided. **Not now** persists dismissal for this browser. Settings remains available afterward.
- The worker reuses `session/store.ts`, including the non-extractable `contentKey`. Inline pushes decrypt locally; reference pushes fetch the encrypted record using the stored token. Notifications carry the push id as their tag. Missing keys, invalid payloads, and unavailable/decryption-failed records produce only **New push**.
- A plain notification click focuses an existing app window and opens `?push=<id>`, with Copy focused, or opens that deep link in a new window. Links additionally offer **Open link**. Subscription changes renew the subscription with the current VAPID key.
- A waiting worker leaves the current app running until **Reload to update** is selected.
- PWA Playwright tests use full Chromium with temporary non-incognito profiles: the headless shell denies notification permission, and incognito blocks native subscriptions and installation. `NativeNotifications` is disabled only for tests so Chromium retains real notifications without depending on the headless host's OS notification center. Subscriptions use the real PushManager; API persistence is checked against the isolated S3 device record. Tests decrypt real crypto payloads with every Pneumo tab closed and zero worker window clients. Synthetic clicks substitute only activation-gated focus/new-window operations; app message delivery, deep-link navigation, and Copy focus remain real. Real push-service delivery remains the M5 owner-browser check.
- Update coverage uses a private random-port proxy that changes only its own worker response, never shared build output. Installability uses CDP `Page.getInstallabilityErrors`, since Lighthouse 12 removed the PWA category.

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

Playwright global setup builds both apps, starts isolated MinIO through `scripts/e2e/minio.ts`, and starts the built server on an OS-assigned port with direct uploads and the web build directory. Each fresh-instance fixture gets another random-port server and unique S3 prefix; signed-in fixtures complete real setup in an isolated browser context. No test depends on ports 8080 or 9000. The harness discovers the assigned port from the existing structured “Server listening” event, then makes one health request within the same 30-second startup deadline. Server output is consumed without forwarding or saving it; no `lsof` subprocess or `/proc` polling is needed. Teardown stops the owned server processes and MinIO. The shared MinIO helper supports Docker or native MinIO.

The suite covers setup, second-browser login, persisted-key decryption, sign-out/re-login, authentication failures, revocation, client-side Back/Forward, connection recovery, and axe scans. Home adds real two-context delivery within two seconds, targeted pushes in both histories, clipboard/Open actions, inline deletion, encrypted-size limits, draft recovery, keyboard focus after sending, decryption failures, pagination, and deep-link focus. The offline replay test closes both sides of a real WebSocket proxy, checks the replacement hello cursor, and requires the missed push frame between `ready` and `replay_done`; HTTP refresh alone cannot satisfy it. Vitest covers composer interactions, history transitions, and the WebSocket lifecycle with fake sockets and timers.

Light/dark Home captures are `home-{empty,items,offline,error}-{light,dark}.png`, with corresponding `home-{empty,items,offline,error}-mobile.png` captures, under `test-results/screens/`. Keyboard-focus captures preserve Message focus after sending: `home-send-{success,error}-focus-{light,dark}.png` and `home-send-{success,error}-focus-mobile.png`. Existing shell captures remain there too. Screenshots are not committed. Traces, video, and automatic failure screenshots are disabled so credentials and session state do not enter artifacts.

Devices captures are `devices-{list,rename,remove-confirm,pairing,paired,revoked-login,self-removed-login}-{light,dark,mobile}.png`; editable Settings captures are `settings-device-name-{light,dark,mobile}.png`. All are under `test-results/screens/` and remain uncommitted. Pairing captures contain only throwaway test-instance QR images, never the raw URI.

Notification captures are `settings-notifications-{off,on,denied,unsupported}-{light,dark,mobile}.png`, `settings-offline-{light,dark,mobile}.png`, `home-notification-prompt-{light,dark,mobile}.png`, and `pwa-update-{light,dark,mobile}.png`, under `test-results/screens/`. The offline-reload flow opens Settings without a network connection and checks its reconnect status. All changed surfaces receive axe checks in each captured theme and viewport. Screenshots remain uncommitted.

File-state axe checks and captures are `file-{unavailable,uploading,item,tamper}-{light,dark}.png` and `file-{unavailable,uploading,item,tamper}-mobile.png` in the same directory. Functional file scenarios run in both upload modes; visual captures use direct mode.
