# Dev client

Run from the repository root with mise's pinned tools and environment:

```sh
mise exec -- pnpm dev-client <command> --session <path>
```

In a mise-activated shell, `pnpm dev-client <command>` is equivalent. mise sets
`pnpm_config_loglevel=silent` because pnpm otherwise echoes credential-bearing
script arguments. Outside that environment, use `pnpm --silent dev-client`.
Do not enable shell tracing for these commands.

Only `@pneumo/protocol`, `@pneumo/crypto`, and Node builtins are used at runtime.
The client uses real key derivation, push envelopes, and streaming file crypto.

## Sessions and authentication

`--session` works before or after the command. The default is
`$TMPDIR/pneumo-dev-session.json` (Node's temporary directory when `TMPDIR` is
unset). The file contains `{ url, deviceId, token, mk }`; `mk` is base64url.
Writes atomically replace the file with mode `0600`. Treat session files as
credentials and remove them when finished.

```sh
pnpm dev-client setup --url http://localhost:8080 \
  --setup-token "$PNEUMO_SETUP_TOKEN" --passphrase "$PASSPHRASE" --session "$A"
pnpm dev-client login --url http://localhost:8080 \
  --passphrase "$PASSPHRASE" --name cli --session "$A"
uri=$(pnpm dev-client pair-uri --session "$A")
pnpm dev-client claim --uri "$uri" --session "$B"
unset uri
```

Setup creates a `cli` device. Login defaults its name to `cli`. Claim acts as an
Android phone and checks the server's key check before saving its session.
Passphrases must be at least 12 characters. Server URLs are HTTP(S) origins;
a trailing slash is accepted. Setup, login, and claim print only the device id.

`pair-uri` prints exactly one URI and nothing else. It contains the master key
by design. Capture it privately; never put it in logs or reports. Supply a
different `--session` path to claim so the original device remains available.

## Pushes and files

```sh
pnpm dev-client send note 'hello' --to "$DEVICE_ID" --session "$A"
pnpm dev-client send link https://example.com --title Example --session "$A"
pnpm dev-client send file ./payload.bin --to "$DEVICE_ID" --session "$A"
pnpm dev-client download "$PUSH_ID" --out ./download.bin --session "$B"
```

Send prints only the push id. Omitting `--to` broadcasts to all devices. Files
use `application/octet-stream`; names come from the source path. Transfer URLs
and headers come from the server, so direct and proxy modes use the same CLI.
Uploads and downloads stream. A failed or tampered download does not replace
the output file or leave its temporary plaintext file behind.

## Live reception

```sh
pnpm dev-client listen --session "$B"
pnpm dev-client wait-for --type note --body hello --timeout 10 --session "$B"
pnpm dev-client wait-for --type link --url https://example.com --timeout 10 --session "$B"
pnpm dev-client wait-for --type file --file-name payload.bin --timeout 10 --session "$B"
```

Listen prints one decrypted JSON object per push, with `id`, `type`, `title`
(or `null`), `source` (device id), and relevant `body`, `url`, or `fileName`.
File keys and session credentials are never included. Ctrl-C stops listening.
Reception starts with live pushes, not existing history. The socket answers
heartbeats and reconnects with an in-memory replay cursor, deduplicating push
ids. Revocation (4401) and protocol errors (4400) stop with a nonzero exit.

Wait-for uses exact string matching, prints the matching decrypted object, and
exits 0. Timeout exits 1 without stdout. Use at most one optional content
filter; without one, any push of the requested type matches. Timeouts are
positive decimal seconds, including fractions. Start the receiver before the
sender.

## Smoke and checks

```sh
pnpm dev-client smoke --url http://localhost:8080 \
  --setup-token "$PNEUMO_SETUP_TOKEN" --session "$A"
pnpm dev-client smoke --url http://localhost:8080 \
  --passphrase "$PASSPHRASE" --session "$A"
mise run check:server
mise run e2e:server
```

On a new server, `--setup-token` selects setup. Its default passphrase is the
fixed fake `pneumo smoke test passphrase`; supply `--passphrase` as well to
override it. On an initialized server, pass only `--passphrase` to log in.
Never use the default smoke passphrase for real private content.

Smoke prints `PASS <step>` or `FAIL <step>` and exits nonzero on failure. It
pairs a second device, verifies targeted note/link delivery over the socket,
round-trips a random 2 MiB file byte-for-byte, observes `push_deleted`, and
checks socket close 4401 after revocation. Created pushes, the paired device,
and temporary files are cleaned up. The primary session remains usable.
Failures do not print raw server errors or credentials.

`check:server` includes the client argument, session-permission, and output
redaction tests plus strict type/lint checks. `e2e:server` runs setup and login
smoke flows against built servers on random ports in both `UPLOAD_MODE=direct`
and `proxy`, sharing only the suite's isolated MinIO harness. No deployed
system is used.
