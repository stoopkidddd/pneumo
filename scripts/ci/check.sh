#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

case "${1:-}" in
  protocol)
    pnpm exec biome check --error-on-warnings package.json pnpm-workspace.yaml tsconfig.base.json biome.json vitest.config.ts packages/protocol packages/crypto
    pnpm --filter @pneumo/protocol --filter @pneumo/crypto run typecheck
    pnpm exec vitest run --project @pneumo/protocol --project @pneumo/crypto
    ;;
  server)
    pnpm exec biome check --error-on-warnings apps/server
    pnpm --filter @pneumo/server run typecheck
    pnpm exec vitest run --project @pneumo/server
    pnpm exec biome check --error-on-warnings package.json scripts/pneumo-dev.ts scripts/pneumo-dev
    pnpm exec tsc --project scripts/pneumo-dev/tsconfig.json
    pnpm exec vitest run --config scripts/pneumo-dev/vitest.config.ts
    ;;
  web)
    pnpm exec biome check --error-on-warnings apps/web
    pnpm --filter @pneumo/web run typecheck
    pnpm exec vitest run --project @pneumo/web
    pnpm --filter @pneumo/web run build
    ;;
  android)
    cd apps/android
    ./gradlew spotlessCheck detekt lint testDebugUnitTest verifyRoborazziDebug
    ;;
  android-static)
    # SDK-free subset only; the full Android lane remains a local merge gate.
    cd apps/android
    ./gradlew spotlessCheck detekt
    ;;
  brand)
    pnpm exec biome check --error-on-warnings scripts/brand-export.mjs brand/tokens.json brand/tokens.schema.json
    pnpm exec node scripts/brand-export.mjs --check
    ;;
  infra)
    docker compose config -q
    hadolint Dockerfile
    find scripts -type f -name '*.sh' -exec shellcheck {} +
    pnpm exec biome check --error-on-warnings scripts/
    pnpm exec tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --types node scripts/e2e/minio.ts scripts/e2e/docker.ts scripts/ci/validate-workflows.ts
    pnpm exec tsx scripts/ci/validate-workflows.ts
    ;;
  *)
    echo "Usage: bash scripts/ci/check.sh {protocol|server|web|android|android-static|brand|infra}" >&2
    exit 2
    ;;
esac
