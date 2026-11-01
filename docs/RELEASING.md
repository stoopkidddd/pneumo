# Local releases

The owner runs releases on the Mac. No CI system receives a signing key or a
registry token. Tangled is the source of truth; the GitHub mirror moves only on
releases. See SPEC §16.4–16.8 and `docs/agents/tangled.md`.

## Prerequisites

- Install the tools pinned by `mise.toml` and workspace dependencies with
  `mise install` and `mise exec -- pnpm install --frozen-lockfile`.
- Install the Android SDK used by `apps/android/app/build.gradle.kts`, including
  Build Tools 37.0.0 (`apksigner`). `mise` supplies `ANDROID_HOME`.
- Run Docker with a buildx builder that supports `linux/amd64,linux/arm64` and the
  cache-only exporter. With Docker Desktop/OrbStack emulation, create a dedicated
  builder once with `docker buildx create --name pneumo-release --driver docker-container`,
  then set `export BUILDX_BUILDER=pneumo-release` in the release shell. This does
  not change the builder selected for other Docker work.
- Configure `gh auth login` for `stoopkidddd` with permission to publish GHCR
  packages and releases in `stoopkidddd/pneumo`. The task obtains the token only
  through `gh auth token | docker login ghcr.io -u stoopkidddd --password-stdin`.
- Configure SSH access to `origin` (Tangled) and `github`
  (`git@github.com:stoopkidddd/pneumo.git`). Only the release task pushes to the
  mirror, and only `main` plus the release tag.
- Complete the one-time signing setup below and commit the public fingerprint.

## One-time signing setup (lead only)

Release certificate SHA-256: not recorded.

The real keystore has not been created by ENG-272. The lead must replace the line
above with `Release certificate SHA-256:` followed by the real 64 hexadecimal
digits in backticks (colon-separated hexadecimal is also accepted). Without that
record, normal releases fail closed. Never use the test certificate here.

Run this on the owner's Mac once, through the pinned Node and Java tools. It
creates `~/.config/pneumo/release.jks` (alias `pneumo`, RSA 4096, validity 10000
days) and `release.env`, both mode 600. Passwords are random and are neither
printed nor passed on the command line. Do not enable shell tracing.

```sh
mise exec -- node --input-type=module <<'JS'
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
process.umask(0o077);
const directory = join(homedir(), '.config/pneumo');
const keystore = join(directory, 'release.jks');
const envFile = join(directory, 'release.env');
if (existsSync(keystore) || existsSync(envFile)) throw new Error('Signing files already exist');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const signing = {
  ANDROID_KEYSTORE_PATH: keystore,
  ANDROID_KEYSTORE_PASSWORD: randomBytes(32).toString('hex'),
  ANDROID_KEY_ALIAS: 'pneumo',
  ANDROID_KEY_PASSWORD: randomBytes(32).toString('hex'),
};
writeFileSync(envFile, Object.entries(signing).map(([key, value]) => `${key}=${value}\n`).join(''), { mode: 0o600, flag: 'wx' });
try {
  execFileSync('keytool', [
    '-genkeypair', '-storetype', 'JKS', '-keystore', keystore, '-alias', 'pneumo',
    '-keyalg', 'RSA', '-keysize', '4096', '-validity', '10000', '-dname', 'CN=Pneumo',
    '-storepass:env', 'ANDROID_KEYSTORE_PASSWORD', '-keypass:env', 'ANDROID_KEY_PASSWORD',
    '-noprompt',
  ], { env: { ...process.env, ...signing }, stdio: 'pipe' });
  chmodSync(keystore, 0o600);
  const certificate = execFileSync('keytool', [
    '-list', '-v', '-keystore', keystore, '-alias', 'pneumo',
    '-storepass:env', 'ANDROID_KEYSTORE_PASSWORD',
  ], { env: { ...process.env, ...signing }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const digest = /SHA256:\s*([A-Fa-f0-9:]+)/.exec(certificate)?.[1];
  if (!digest) throw new Error('Certificate fingerprint missing');
  console.log(`Release certificate SHA-256: \`${digest}\``);
} catch {
  // Do not print third-party errors: they can contain child output or credentials.
  console.error('Signing setup failed; inspect the files locally before trying again');
  process.exitCode = 1;
}
JS
```

`release.env` is a data file, not a shell script. It accepts exactly these four
`KEY=value` entries, optional matching outer quotes, blank lines and comments.
No `export`, expansion, escapes, interpolation or commands. Use an absolute
keystore path. Do not source this file into the shell. The release task reads it
and supplies its values only to the Gradle child, with `--no-daemon` and
`--no-configuration-cache`. Gradle output is captured, not printed, so a child
failure cannot echo a password. Other checks, Docker, Git and `gh` do not receive
the signing variables.

**Back up `~/.config/pneumo/` securely, including both files.** Keep the signing
key on the owner's Mac for builds, never in git, CI, release assets or a shared
log. Loss of the keystore or its passwords prevents signing compatible updates:
users must uninstall the app, lose its local data, and pair again. A different
certificate cannot update an installed copy.

## Cut a release

1. Merge the release changes through Tangled. In a clean `main` checkout, run
   `git pull --ff-only origin main`. Every `v*` tag must be a SemVer release tag.
2. On Tangled's Pipelines tab, confirm CI is green for this exact commit. The task
   prints a reminder but cannot confirm the web-only pipeline status for you.
3. Optionally run a full local rehearsal with the real key:
   `mise run release 0.1.0-rc.1 --dry-run`.
4. Publish with `mise run release 0.1.0-rc.1`.

Both modes require `main`, a clean tree (including untracked files), equality with
`origin/main`, a valid SemVer without a leading `v`, and a version strictly newer
than the highest `v*` tag by SemVer precedence. The task fetches `origin/main` and
tags, checks equality again, and runs `mise run check`. Dry-run skips none of
these checks. Release commits are rechecked after checks and builds.

Both modes build the multi-arch image with `VERSION=<version>`, then a signed,
minified APK with Gradle properties `releaseVersionName` and `releaseVersionCode`.
The APK must pass `apksigner verify --print-certs` and match the fingerprint above
before anything is written to `dist/release`. Successful builds write exactly
`pneumo-<version>.apk` and `SHA256SUMS` for that APK. Existing artifacts from other
versions are not deleted and are not uploaded.

Only after successful local verification does normal mode authenticate to GHCR,
export/push the cached multi-arch build, create the annotated `v<version>` tag,
push the tag to Tangled, push `main` and the tag to the mirror, and create the
mirror's GitHub Release with the two files. Notes contain commits since the
previous release, install/checksum steps and the image reference. Versions with
an `rc` first prerelease identifier (for example `0.1.0-rc.1`) get `--prerelease`
and never move `latest`. Other versions also publish `latest`. SemVer build
metadata uses `_` instead of `+` in the Docker tag because Docker disallows `+`;
the full version is preserved in the image label, server and APK.

Dry-run uses `--output=type=cacheonly`: no image export/push, Docker login, tag
creation, Git push or GitHub Release. It prints the publication commands it would
run without executing them. It still fetches from `origin` and leaves verified
local APK/checksum artifacts and build caches. Publication commands are all in
one explicit non-dry-run branch. A partial network publication failure is not
rolled back automatically: inspect the registry, tags and release before taking
any further action; do not blindly rerun with the same version.

### Android versions

`versionName` is the complete version argument. `versionCode` is
`major * 10000 + minor * 100 + patch`, ignoring the prerelease suffix and build
metadata. The task requires Android's valid range of 1–2100000000. Components
must stay below 100 for minor/patch if releases are to have distinct, increasing
codes with this formula. Without the properties, Gradle keeps dev defaults
`versionName = "0.0.1"`, `versionCode = 1`. With none of the signing variables,
`assembleRelease` remains unsigned; partial signing configuration fails.

`0.1.0-rc.1` and `0.1.0` both have code **100** (as does `0.1.0-rc.2`). Android
requires a strictly higher code for an update: do not promise an in-place update
from RC to final of the same core version. Uninstall/reinstall and pair again,
or wait for a later core version with a higher code. Uninstalling loses local
app data. There is no separate RC numbering scheme.

## Verify a published image and APK

```sh
docker pull ghcr.io/stoopkidddd/pneumo:0.1.0-rc.1
IMAGE=ghcr.io/stoopkidddd/pneumo:0.1.0-rc.1 mise run e2e:docker
docker buildx imagetools inspect ghcr.io/stoopkidddd/pneumo:0.1.0-rc.1
# In the directory containing the downloaded APK and SHA256SUMS:
shasum -a 256 -c SHA256SUMS
mise exec -- "$HOME/Library/Android/sdk/build-tools/37.0.0/apksigner" verify --print-certs pneumo-0.1.0-rc.1.apk
```

The `IMAGE` smoke uses an already-pulled/local image, checks its version label,
health response, web assets, non-root UID, size, direct/proxy encrypted transfers
and clean shutdown. It builds only the local build-stage smoke client; it does
not rebuild runtime images or remove the supplied image. Without `IMAGE`,
`mise run e2e:docker` retains the local explicit/default-version build checks.

## Test-only signing overrides

For an isolated rehearsal without the real key, create a throwaway keystore and
mode-600 env file in a temporary directory using the same signing setup, with
the directory changed to that temporary path. Do not create or modify
`~/.config/pneumo/`. Delete the throwaway key, env file, logs and APKs afterwards.
Use a disposable clean `main` clone with a local `origin` to avoid modifying the
implementation branch or contacting Tangled during implementation checks.

Set **both** overrides for that process:

- `PNEUMO_RELEASE_ENV`: absolute path to the throwaway `release.env`.
- `PNEUMO_RELEASE_CERT_SHA256`: the throwaway certificate's public SHA-256 digest.

```sh
PNEUMO_RELEASE_ENV=/absolute/temp/release.env \
PNEUMO_RELEASE_CERT_SHA256="$TEST_CERT_SHA256" \
  mise run release 0.1.0-rc.1 --dry-run
```

Set `TEST_CERT_SHA256` to the public digest printed during throwaway key setup.
Install dependencies in the disposable clone rather than symlinking its
`node_modules`: pnpm's task runner rejects a symlinked task-state directory.

These overrides require each other and `--dry-run`; normal publication rejects
them. They do not bypass branch, cleanliness, origin equality, version or checks.
A wrong digest must exit nonzero and write no release artifacts. Capture the run
output, scan it for both test passwords **without printing either**, and report
only the match count (expected **0**). Do not print raw captured child errors.
