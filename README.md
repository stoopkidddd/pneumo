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
`@pneumo/web`. The shared packages expose TypeScript source to workspace consumers. Crypto imports
protocol through a `workspace:*` dependency; both packages are empty until their implementation issues.

```sh
mise run check:protocol  # Biome, TypeScript and Vitest for protocol and crypto
mise run check:server    # Biome, TypeScript and Vitest for the server
mise run check:web       # Biome, TypeScript, Vitest and a Vite production build
mise run android:setup   # Configure the local SDK path on a fresh checkout
mise run check           # All implemented lanes, including Android
mise run fmt             # Format TS packages and root config; exclude Android, brand and generated files
```

`mise exec -- pnpm test` runs all four Vitest projects. Start the minimal web app with
`mise exec -- pnpm --filter @pneumo/web dev`. Build the server with
`mise exec -- pnpm --filter @pneumo/server build`; its JavaScript output is in `apps/server/dist`.

License: MIT.
