# 0002. Raise the image size cap to 300 MB

- **Status:** accepted
- **Date:** 2026-10-31
- **Issue:** ENG-267
- **Spec:** `docs/SPEC.md` §16.1

## Context

§16.1 requires the runtime stage to use `node:26-slim` and caps the image at 250 MB.
In ENG-267 the current `node:26-slim` base alone measured 271,952,023 bytes
(uncompressed, as `docker images` reports), so no image built on it can meet the cap.
The finished Pneumo image measured 290,761,378 bytes: the application layers
(server dist, web dist and production dependencies) add about 19 MB.

## Decision

Keep the `node:26-slim` runtime and raise the cap to 300 MB, measured as the
uncompressed image size that `docker image inspect` reports. `mise run e2e:docker`
asserts the new cap.

## Consequences

The cap still catches regressions in what Pneumo adds, such as dev dependencies or
build caches leaking into the runtime stage. A smaller base (Alpine or distroless)
was not adopted: it would change the runtime libc or tooling for a saving that
doesn't matter on Railway. A future Node base-image size increase may need this
cap revisited.
