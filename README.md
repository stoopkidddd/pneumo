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

Copy `.env.example` to `.env.local`, then run `mise exec -- pnpm --filter @pneumo/server dev`
for the server watcher. For a production-style local run:

```sh
mise exec -- pnpm --filter @pneumo/web build
mise exec -- pnpm --filter @pneumo/server build
mise exec -- node --env-file=.env.local apps/server/dist/index.js
```

The server serves the built web app and `GET /api/health`. `WEB_DIST_DIR` defaults to
`apps/web/dist`, resolved relative to the server rather than the current directory. Health reads
the server package version; `initialized` remains false until setup is implemented. Storage is
currently an injected interface stub: startup makes no bucket calls and does not wait for
`minio-init`. Storage startup retries belong to ENG-249.

`check:server` also builds the server and launches the bundle with plain Node, an ephemeral port,
and a temporary web fixture. It checks health, HTML serving, safe config failures, and SIGTERM
shutdown. The shutdown hook list in `src/index.ts` is the registration point for the later
WebSocket hub; hooks receive close code 1012, with a ten-second drain deadline.

The injected `Clock.now()` returns Unix epoch milliseconds, matching `Date.now()`. Tests use
epoch-millisecond fake clocks so timestamps and expiry calculations share the production unit.
Request log durations are differences between clock readings, clamped to zero on backward jumps.

License: MIT.
