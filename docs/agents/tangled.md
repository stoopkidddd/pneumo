# Tangled delivery workflow

This document records the proven commands for PRs, review rounds, merges and CI on Tangled, which take precedence over §5 of the Linear playbook when they differ.

## Remotes

| Remote | URL | Use |
| -- | -- | -- |
| `origin` | `demi.dev@tangled.org:did:plc:qzsds2tco6vi45xxqy4uk5cx` | Tangled source of truth |
| `github` | `git@github.com:stoopkidddd/pneumo.git` | Read-only distribution mirror, added in M5 (Ship v0.1.0) |

The repo DID survives renames. The SSH user `demi.dev` lets `knot1.tangled.sh` find the owner's published key.

Check access:

```sh
git ls-remote origin
```

`ssh -T git@tangled.org` only prints the knot's greeting. It does not prove repo access.

The first `git push -u origin main` confirmed write access on 2026-10-31.
Only `mise run release` pushes to `github`, and only `main` plus release tags.

## tang does not work with this repo

`tang` 0.0.3 cannot resolve this repo:

| Command | Output |
| -- | -- |
| `tang pr list -R demi.dev/pneumo` | `repository pneumo not found for demi.dev` |
| `tang repo list` | `[]` |

The owner's PDS uses an `org.tangled.repo.declaration` record with rkey `pneumo`, which points to the repo DID.
`tang` 0.0.3 only reads the older `sh.tangled.repo` records.

Use the Tangled web UI for every PR operation, through browser automation (Claude in Chrome) in the owner's Chrome.
The browser must be signed in as `demi.dev`. If Chrome shows the sign-in page, ask the owner to sign in.

`tang auth refresh` renews the two-hour session without the password.
It is not needed for this repo until `tang` supports the new records.

When a new `tang` release appears, check repo support:

```sh
brew upgrade onevcat/tap/tang && tang pr list -R demi.dev/pneumo --state all
```

## Commands

### Push

```sh
git push -u origin <branch>
```

Print the spindle's workflow validation report:

```sh
git push -o verbose-ci origin <branch>
```

Validation problems print even without `verbose-ci`.
With no files in `.tangled/workflows/`, the push prints `remote: no pipelines to compile`.

Skip pipelines for one push:

```sh
git push -o skip-ci origin <branch>
```

### Create a PR

1. Open `https://tangled.org/demi.dev/pneumo/pulls/new?source=branch&sourceBranch=<branch>&targetBranch=main`.
2. Fill **Title** and **Body** with `form_input`.
3. Click **Create pull request**.

The form pre-fills both branches and the title from the latest commit.
The page redirects to `/pulls`. PR #1 appeared immediately, without AppView lag.

### View

1. Open `https://tangled.org/demi.dev/pneumo/pulls/<N>`.
2. Read the body with `get_page_text`.

The URL redirects to `/pulls/<N>/latest`.
The page shows commits, each commit's pipeline status, the diff (**Unified** or **Split**), and the **Comments** panel.

### Diff

```sh
git diff origin/main...<branch>
```

The PR matches the branch as of the latest **Resubmit**, not necessarily the current branch head.

### Comment

1. Find **Write your comment here** at the bottom of the right-hand **Comments** panel.
2. Fill the textarea with `form_input`.
3. Click into the textarea.
4. Press `cmd+Enter`.
5. Reload the page.
6. Count occurrences of a unique heading before you send another comment.

The comment attaches to the PR's latest commit (**Comment on <sha>**).
`form_input` leaves **Send comment** disabled. The keypress sends the comment.
The panel does not refresh after sending. Reloading and counting the heading prevents duplicate comments.

### Resubmit a new round

1. Commit the fixes on the same branch and push: `git push origin <branch>`.
2. Open `https://tangled.org/demi.dev/pneumo/pulls/<N>`.
3. Click **Resubmit** in the **Commits** header, next to the round selector (`v0`, `v1`, …).

There is no dialog. Within a few seconds the round selector moves to the next round, and the PR shows the new commits and diff.
**Resubmit** only appears while the branch has commits the PR doesn't have yet.
Comments are grouped by round in the **Comments** panel.
Pipelines run again for the new round, if the branch has workflow files.

### Merge

0. Confirm the PR shows no **Resubmit** button and the newest round's head matches `git rev-parse --short <branch>`. If either check fails, resubmit a new round. Repeat both checks before merging.
1. Click **Rebase & merge**, at the bottom right of the PR page.
2. Then update the local checkout and remove the branch:

```sh
git pull --ff-only origin main
git push origin --delete <branch>
git worktree remove .claude/worktrees/<eng-id>
git branch -D <branch>
```

The button's dropdown offers **Rebase** and **Manually mark as merged**. Never use **Manually mark as merged**: it closes the PR without applying the patch.

## Reading pipeline (CI) status for a PR

The PR's **Commits** section shows each commit's pipeline status, such as `2/2 running` or `1/2`.

1. Open `https://tangled.org/demi.dev/pneumo/pipelines`.
2. Select **All**, **Push**, or **Pull request**.
3. Open a run at `/pipelines/<runId>/workflow/<file>.yml`.
4. Read the page with `get_page_text`.

Each run shows workflow status and per-step logs with durations.
Statuses include **Passed**, **Running**, **Waiting for the spindle** (queued), **Failed**, and `timeout`.
There is no CLI for pipeline status.

## Hosted spindle

Measured on 2026-10-31, PR #1.

**Settings → Pipelines** already selected Tangled's hosted spindle. No owner change was necessary.
A `pull_request` to `main` triggered both files in `.tangled/workflows/` and showed `2/2`.

### microvm and Docker

The `microvm` engine is available. Docker works on an amd64 runner with these workflow keys:

```yaml
engine: microvm
image: nixos
virtualisation:
  docker: true
```

`docker run --rm hello-world` passed:

| Stage | Duration |
| -- | -- |
| microVM setup | 5 s |
| Clone | 0 s |
| NixOS config activation | 20 s |
| Docker step | 4 s |
| Total | 29 s |

### nixery

The `nixery` engine is available with these workflow keys:

```yaml
engine: nixery
dependencies:
  nixpkgs: [nodejs, coreutils]
```

The Node version and timeout probe passed:

| Stage | Duration |
| -- | -- |
| Pull image from Nixery | 5 s |
| Configure Nix | 0 s |
| Clone | 0 s |
| `node --version` | 0 s |
| `sleep 330` | 5 m 30 s |
| Total | 5 m 35 s |

The nixpkgs `nodejs` package provides Node **v22.22.0**, not Node 26.
The lane workflows request `nodejs_26` explicitly from `nixpkgs/nixpkgs-unstable`, rather than relying on that default.
PR #9 confirmed that this attribute resolves on the hosted spindle to Node **v26.13.0**. There is no local Nix installation.

### ENG-277 first hosted lane run

The lead opened PR #9 after pushing `d5936f1`: no workflows ran. The probe commit `a3cf328` removed `paths` from only the TS workflow's `pull_request` condition. After resubmission, only `ts.yml` started; infra and Android still did not match. This establishes the hosted quirk: paths filters don't match on pull_request; every PR runs all three workflows after the round-two fix. Keep path filters only on separate `push` conditions.

The TS workflow failed during dependency installation, not a lane check:

| Stage | Cold duration | Result |
| -- | -- | -- |
| Pull image from Nixery | 2 s | Passed |
| Configure Nix | 0 s | Passed |
| Clone repository into workspace | 0 s | Passed |
| Install custom dependencies | 27 s | Passed; `nodejs_26` resolved |
| Install locked dependencies | 8 s | Failed: switched pnpm shim could not find `sed` |
| Total | 37 s | Failed before any lane check |

The install log printed Node v26.13.0. nixpkgs' pnpm switched to the repo-pinned 11.28.10; its shell shim then failed at line 14 (`sed: command not found`) and tried the incorrect module path `/tangled/node_modules/pnpm/bin/pnpm.mjs`. Round two added the shim's shell utilities rather than abandoning the pinned version. The next hosted run confirmed installation, then exposed the native-loader failure below.

### ENG-277 second hosted lane run and Nixery runtime

After `8b6db55`, all three PR workflows triggered. The pipeline finished **0/3 in 3 m 25 s**:

| Workflow | Hosted total | Relevant stages / failure |
| -- | -- | -- |
| `ts.yml` | 48 s | Image pull **8 s**, custom dependencies 28 s, frozen install 12 s passed; protocol failed after 1 s starting Biome |
| `infra.yml` | 52 s | Compose config and shellcheck passed; Biome failed with the same `spawnSync … ENOENT` |
| `android.yml` | 1 m 43 s | Image pull **1 m 43 s cold**; `java -version` failed with `java: command not found` |

The hosted TS versions were Node **26.13.0**, pnpm **11.28.10**, and Python **3.14.8**. These failed totals are not successful lane durations or evidence of timeout fit.

Round three reproduced all three failures before editing in disposable `linux/amd64` containers from [public Nixery](https://nixery.dev/). Public Node was 26.10.0 and Python 3.14.7: its default package revision is not identical to the hosted `nixpkgs/nixpkgs-unstable` registry. Baseline container totals including pulls were 164.35 s for TS (exit 255), 114.68 s for infra (exit 255), and 174.22 s for Android (exit 127). OrbStack's amd64 emulator reported the missing loader directly instead of Node's `ENOENT`.

The diagnosis was confirmed with `patchelf`: the Biome 2.6.4 executable exists but requests `/lib64/ld-linux-x86-64.so.2`, absent from the Nixery filesystem. Nix's Node and bash instead encode a glibc interpreter under `/nix/store`. A missing ELF interpreter makes execution fail even when the executable file exists.

`scripts/ci/run-nixery.sh` now wraps **every workflow step**, because Nixery starts a fresh container for each step. On x86-64 Linux with `/nix/store`, it derives the glibc loader from Node (or bash when Node is absent) with `patchelf`; only when the standard loader is missing does it create that symlink inside the container. It exports only the store directories containing GCC runtime libraries in `LD_LIBRARY_PATH`; the linked loader finds its own libc. Never put a glibc directory on `LD_LIBRARY_PATH`: on the hosted spindle, base-image tools such as `/bin/sh` use an older glibc than the `nixpkgs/nixpkgs-unstable` packages, and the hosted run of `954d004` failed with `/bin/sh: symbol lookup error: … glibc-2.44 … libc.so.6: undefined symbol: __pointer_chk_guard, version GLIBC_PRIVATE` (exit 127). Public Nixery serves one channel, so local containers can't reproduce that mismatch. Explicit `glibc` and `gcc-unwrapped.lib` dependencies supply libc, `libgcc_s.so.1`, and `libstdc++.so.6`. Using store paths avoids depending on the public image's `/lib` symlink forest, which custom-registry dependencies need not populate. The wrapper does not patch node_modules, change Biome 2.6.4, or alter the Mac's loader paths.

The original `jdk17` image contains `/lib/openjdk/bin/java`, not `/bin/java`; Java was installed but off `PATH`. Android now requests `jdk17_headless`, sets `JAVA_HOME=/lib/openjdk`, and uses the same wrapper to prepend `$JAVA_HOME/bin` for both steps. `GRADLE_USER_HOME` remains `/tangled/workspace/.gradle`.

### Scheduling and timeout

The two workflows ran sequentially, not in parallel.
The `nixery` workflow showed **Waiting for the spindle** until `microvm` finished.
The pipeline took **6 m 4 s**: 29 s for `microvm` plus 5 m 35 s for `nixery`.
Keep workflows short because total CI time is the sum of the workflows.

The observed timeout is at least **5 m 35 s**. A workflow of that duration passed.
The hosted spindle did not enforce the documented five-minute default. The actual limit is unknown.
Do not plan workflows near an assumed limit.

Per Tangled's docs, the timeout includes queued time (**Waiting for the spindle**).
A run that exceeds the limit ends with status `timeout`.
The spindle operator sets the timeout. Workflow files have no timeout key.

## CI coverage table

ENG-277 adds three `nixery` workflows, triggered on `push` to `main` and `pull_request` targeting `main`. Hosted quirk: paths filters don't match on pull_request; every PR runs all three workflows. Each workflow therefore has an unfiltered PR condition and a separate path-filtered push condition. A push condition's `paths` is a list of globs, not an `include`/`exclude` map. Shared configuration, CI scripts, workflow files and this document trigger the affected push groups.

| Lane | CI or local-only | Workflow / reason | Hosted duration (2026-10-31) |
| -- | -- | -- | -- |
| pneumo-protocol | CI | `ts.yml`: full `check:protocol`, including the Python crypto cross-check | step 10 s |
| pneumo-server | CI | `ts.yml`: full `check:server` | step 11 s |
| pneumo-web | CI | `ts.yml`: full `check:web`, including the production build | step 3 s |
| pneumo-android | **local-only** (full lane); static subset in CI | `android.yml`: only `spotlessCheck detekt`. The hosted spindle has no Android SDK (37.2 / build-tools 37.0.0), so lint, JVM tests and screenshots stay local. Run `mise run check:android` before merging any Android change. | workflow 51 s (Gradle step 41 s, including the Gradle 9.8.2 download) |
| pneumo-infra | CI | `infra.yml`: full `check:infra`; Compose config needs a client, not a Docker daemon | step 3 s |
| pneumo-brand | CI | `infra.yml`: full `check:brand`, after infra; all generated outputs matched git on the hosted Linux runner | step 2 s |

Measured on PR #9 (first green hosted run, `986b257`, pnpm and Gradle caches empty):

| Workflow | Total | Main costs |
| -- | -- | -- |
| `ts.yml` | 1 m 2 s | Nix dependency install 26 s, `pnpm install` 7 s, checks 24 s |
| `infra.yml` | 42 s | Nix dependency install 26 s, `pnpm install` 7 s, checks 5 s |
| `android.yml` | 51 s | Gradle step 41 s |
| **Pipeline** | **2 m 35 s** | The workflows run one after another, so the pipeline is their sum. |

The next run (`37db504`, caches saved) took 2 m 24 s. "Install custom dependencies" (the Nix packages) is about 26 s on every run, and no `cache:` entry covers it.

**CI can fail (proven):** `37db504` added a test that fails on purpose (`apps/server/src/ci-red.test.ts`). `ts.yml` failed at `check:server` with exit 1, and `infra.yml` and `android.yml` passed. The next round dropped that commit and the pipeline went green again.

**Log viewer quirk:** the hosted log for a Node check step can show only its first output line (for example Biome's `Checked … files`) and not vitest's results. Read the step status (Passed/Failed, exit code) rather than looking for test counts.

### Reproduce CI locally in Nixery

A macOS `env -i`/minimal-PATH smoke is insufficient: it missed the Linux ELF interpreter and Java layout. Use the public registry's default package channel with the same explicit package attributes as the workflow. It is the closest available public equivalent, **not** the hosted custom registry revision. On 2026-10-31 the public images supplied Node 26.10.0, selected pnpm 11.28.10, Python 3.14.7 and headless OpenJDK 17.0.20.1.

From a committed checkout, make three disposable clones. Never mount the Mac worktree's node_modules into Linux:

```sh
scratch=$(mktemp -d)
for lane in ts infra android; do
  git clone --quiet --local --no-hardlinks . "$scratch/$lane"
done
TS_COPY="$scratch/ts"
INFRA_COPY="$scratch/infra"
ANDROID_COPY="$scratch/android"

TS_IMAGE=nixery.dev/shell/nodejs_26/pnpm_11/python3/bash/coreutils/gnused/gnugrep/findutils/which/gawk/git/gnutar/zstd/patchelf/glibc/gcc-unwrapped.lib
INFRA_IMAGE=nixery.dev/shell/nodejs_26/pnpm_11/bash/coreutils/gnused/gnugrep/findutils/which/gawk/git/docker-client/hadolint/shellcheck/gnutar/zstd/patchelf/glibc/gcc-unwrapped.lib
ANDROID_IMAGE=nixery.dev/shell/jdk17_headless/bash/coreutils/gnused/gnugrep/findutils/which/gawk/git/curl/unzip/gnutar/zstd/patchelf/glibc/gcc-unwrapped.lib
```

These are the container commands exercised in round three (copy paths are parameters). Each invokes the exact workflow install/check commands with the same environment; the hosted workflows additionally repeat the runtime wrapper for each fresh step container.

```sh
/usr/bin/time -p docker run --rm --platform linux/amd64 \
  --name eng277-r3-ts-cache-only \
  -v "$TS_COPY:/tangled/workspace" -w /tangled/workspace \
  -e CI=true -e PNPM_HOME=/tangled/workspace/.pnpm \
  "$TS_IMAGE" bash scripts/ci/run-nixery.sh bash -euc '
node --version
pnpm --version
python3 --version
pnpm install --frozen-lockfile --store-dir .pnpm-store
bash scripts/ci/check.sh protocol
bash scripts/ci/check.sh server
bash scripts/ci/check.sh web'

/usr/bin/time -p docker run --rm --platform linux/amd64 \
  --name eng277-r3-infra-cache-only \
  -v "$INFRA_COPY:/tangled/workspace" -w /tangled/workspace \
  -e CI=true -e PNPM_HOME=/tangled/workspace/.pnpm \
  "$INFRA_IMAGE" bash scripts/ci/run-nixery.sh bash -euc '
node --version
pnpm --version
pnpm install --frozen-lockfile --store-dir .pnpm-store
bash scripts/ci/check.sh infra
bash scripts/ci/check.sh brand'

/usr/bin/time -p docker run --rm --platform linux/amd64 \
  --name eng277-r3-android-cache-only \
  -v "$ANDROID_COPY:/tangled/workspace" -w /tangled/workspace \
  -e CI=true -e JAVA_HOME=/lib/openjdk \
  -e GRADLE_USER_HOME=/tangled/workspace/.gradle \
  "$ANDROID_IMAGE" bash scripts/ci/run-nixery.sh bash -euc '
java -version
bash scripts/ci/check.sh android-static'
```

#### Round-three container results

Measured on 2026-10-31 with Docker's amd64 emulation on the owner's arm64 Mac. The final runs used fresh tracked-file copies and restored only the declared cache paths, with no node_modules, project outputs or Gradle task history. Images were already pulled; these totals include container startup and the full install/check commands, but exclude clone and cache archive transfer.

| Workflow | Final cache-only warm duration | Exit | Exercised result |
| -- | -- | -- | -- |
| `ts.yml` | **84.13 s** | **0** | Biome 2.6.4, types, 202 protocol/crypto tests including Python, server/web tests, and Vite's rolldown production build |
| `infra.yml` | **46.69 s** | **0** | Compose config, shellcheck, Biome, infrastructure types, workflow validation, resvg export; all 40 generated brand outputs match git on Linux |
| `android.yml` | **34.19 s** | **0** | Headless JDK 17, Gradle 9.8.2, `spotlessCheck detekt`; five tasks executed without an SDK |

The first successful Android container run took **276.34 s including its image pull and cold Gradle/dependency downloads**. The log confirms the wrapper downloaded Gradle 9.8.2, then executed all five static-check tasks. Warm pnpm installs reused all 79 packages with zero package downloads.

An additional container probe hid the public image's `/lib` forest and removed its now-dangling `/lib64` alias. The final store-path-based wrapper still ran Biome 2.6.4, the rolldown Vite build, and the resvg brand check: **exit 0, 17.54 s**. This checks native loading without relying on the public image's library symlinks.

These are **local Nixery measurements, not hosted durations or proof of the hosted timeout fit**. The public package revision differs from Tangled's, and the local containers were emulated. The hosted measurements are in the CI coverage table. The full Android lane stays a local merge gate.


For a cache-only warm rerun, make fresh clones and restore **only** `.pnpm-store`/`.pnpm` for TS/infra and `.gradle/caches`/`.gradle/wrapper` for Android from the previous copies. Do not carry node_modules, project build outputs, or Gradle project task history across clones. The Gradle home stays at the workflow's workspace path, with no SDK configuration.

Use `--rm` for containers. Remove the disposable copies afterward, and remove only image tags absent before your run. Do not use a Docker prune against other projects.


### Toolchain, caches and validation

* `scripts/ci/check.sh` owns the lane commands; mise tasks and workflows call the same wrapper. CI additionally wraps every step in `scripts/ci/run-nixery.sh` for its loader, native-library and Java environment. Every existing task and the root `check` dependency list remain intact. No workflow runs `mise install` or requires mise.
* TS and infra use the documented `nixpkgs/nixpkgs-unstable` registry syntax with `nodejs_26` and `pnpm_11`. PR #9 confirmed Node 26.13.0. Node's major matches mise; its exact patch depends on the runner's nixpkgs revision and is printed in the install step.
* [Upstream `pnpm_11`](https://github.com/NixOS/nixpkgs/blob/master/pkgs/development/tools/pnpm/default.nix) currently supplies 11.27.0, versus the repo's 11.28.10. Keep package-manager version management enabled: both the hosted run and public Nixery containers selected 11.28.10 and installed the lockfile. `PNPM_HOME` remains inside the cached workspace so the selected version survives fresh Nixery step containers.
* Every pnpm/Gradle workflow explicitly includes bash, coreutils, gnused, gnugrep, findutils, which and gawk. coreutils supplies the shim's `readlink`/`dirname`/`uname`; gnused supplies `sed`. TS also includes `python3` for the vector cross-check. Infra includes git for brand comparisons, `docker-client` (with Compose), shellcheck, and hadolint. There is currently no Dockerfile to lint or build; Docker build checks belong to the Dockerfile issue, not ENG-277.
* Android requests `jdk17_headless`, sets `JAVA_HOME=/lib/openjdk`, and uses curl/unzip plus the common `xargs`/`sed` launcher utilities. The Nixery wrapper exports the JDK bin directory on `PATH`. Its explicitly workspace-backed `GRADLE_USER_HOME` is not a temporary directory. Only Gradle's `caches` and `wrapper` directories are archived.
* pnpm caches `.pnpm-store` and `.pnpm`, hashed by `pnpm-lock.yaml`. Gradle hashes `apps/android/gradle/libs.versions.toml` and `apps/android/gradle/wrapper/gradle-wrapper.properties`. All entries use `fallback: true`; every image includes `gnutar` and `zstd` for cache archives.
* `check:infra` parses workflow YAML with `scripts/ci/validate-workflows.ts`. It checks common, trigger/schedule, clone, cache, step and engine-specific key lists from the [Tangled workflow reference](https://tangled.org/docs/spindles/workflows/), including the differing dependency shapes. Registry names, environment variable names and NixOS option maps remain open-ended. This is a supported-key check, not a replacement for spindle validation.
* A temporary workflow containing unsupported top-level `timeout` made `mise run check:infra` exit 1 with `unsupported key "timeout"`. Removing it restored exit 0. Fifteen throwaway validator scenarios also covered valid engines/schedules, nested unknown keys, dependency shape, duplicate keys, invalid YAML and the acceptance of ignored NixOS options on non-NixOS microVM images.

### Lead's hosted verification round

1. Push round three and resubmit PR #9; verify all three workflows pass. Record resolved tool versions, cold totals, then a warm-cache rerun with per-lane and per-workflow durations in the tables above. Do not mark a lane confirmed CI until this evidence exists.
2. If Linux brand output differs, mark full `check:brand` local-only and remove its CI step; do not re-record generated assets merely to make Linux green. Keep the useful infra workflow.
3. If any group cannot fit the observed hosted limit (including queue time), mark the affected lane local-only with the measured reason and retain a workflow only for a useful subset.
4. Push a deliberately failing check commit, observe a red pipeline, then revert it in the next round and observe green. This lead-only acceptance test is separate from the local validator failure proof.
5. Before merging, run full `mise run check:android` locally and every lane marked local-only. e2e coverage is outside ENG-277.


## Known Tangled quirks

| Quirk | Operator action |
| -- | -- |
| `tang` 0.0.3 cannot resolve `org.tangled.repo.declaration` repos. | Use the web UI as specified in the `tang` section. |
| The comments panel does not refresh after sending. | Reload before counting a unique heading to prevent duplicate comments. |
| `form_input` does not enable **Send comment**. | Click into the textarea and press `cmd+Enter`. |
| Merging applies the patch as new commits, so commit IDs on `main` differ from the branch. | Delete the source branch after merging. |
| Each workflow file has exactly one engine. | Use two files to test two engines. |
| The spindle rejects unknown workflow keys. | Use the workflow validation report. |
| paths filters don't match on pull_request; every PR runs all three workflows. | Omit `paths` from PR conditions; keep a separate path-filtered `push` condition. |
| A non-main push with `-o verbose-ci` reports `workflow skipped: didn't match trigger push` for every workflow. | Expected: these files parse, but only pushes to `main` trigger them. Resubmit PR #9 to exercise the PR conditions. |
| Nixery lacks the FHS ELF interpreter requested by npm's native executables. | Wrap each step with `run-nixery.sh` and include `patchelf`, `glibc`, and `gcc-unwrapped.lib`; `ENOENT` does not necessarily mean the binary is absent. |
| Nixery's JDK is under `/lib/openjdk`, off the default `PATH`. | Set `JAVA_HOME=/lib/openjdk`; the Nixery wrapper prepends its bin directory. |
| `nixery` steps have no Docker. | Use `microvm`, `image: nixos`, and `virtualisation.docker: true` for Docker. |
