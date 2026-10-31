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

The install log printed Node v26.13.0. nixpkgs' pnpm switched to the repo-pinned 11.28.10; its shell shim then failed at line 14 (`sed: command not found`) and tried the incorrect module path `/tangled/node_modules/pnpm/bin/pnpm.mjs`. Round two adds the shim's shell utilities explicitly rather than abandoning the pinned version. A successful hosted install and warm timings remain pending.

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

| Lane | CI or local-only | Workflow / reason | Local warm check time | Hosted warm duration |
| -- | -- | -- | -- | -- |
| pneumo-protocol | CI (pending first run) | `ts.yml`: full `check:protocol`, including the Python crypto cross-check | 8.11 s | Pending lead measurement |
| pneumo-server | CI (pending first run) | `ts.yml`: full `check:server` | 2.98 s | Pending lead measurement |
| pneumo-web | CI (pending first run) | `ts.yml`: full `check:web`, including the production build | 4.29 s | Pending lead measurement |
| pneumo-android | local-only (full lane); static subset CI (pending first run) | `android.yml`: only `spotlessCheck detekt`; SDK 37.2 / build-tools 37.0.0, lint, JVM tests and screenshots remain local | 0.74 s subset; 8.32 s full lane with local SDK | Pending lead measurement (subset only) |
| pneumo-infra | CI (pending first run) | `infra.yml`: full `check:infra`; Compose config needs a client, not a Docker daemon | 3.27 s | Pending lead measurement |
| pneumo-brand | CI (pending first run) | `infra.yml`: full `check:brand`, sequential after infra; Linux PNG byte identity is not yet proven | 2.09 s | Pending lead measurement |

### Local timing evidence, not hosted timings

Measured on 2026-10-31 on darwin-arm64, with Node 26.10.0, pnpm 11.28.10 and Temurin 17.0.20.1. The check commands also passed with no `mise` binary on `PATH`. Local pnpm/Gradle dependency caches were warm; Gradle's normal home was unchanged.

| Workflow group | Local check-step total | Includes | Hosted total |
| -- | -- | -- | -- |
| `ts.yml` | 16.78 s | Frozen install using the local pnpm store, protocol, server, web | 37 s cold, failed install; successful/warm run pending |
| `infra.yml` | 6.25 s | Frozen install using the local pnpm store, infra, brand | Pending first run and warm-cache rerun |
| `android.yml` | 0.77 s | Java version, SDK-free static subset | Pending first run and warm-cache rerun |

These totals exclude Nixery image setup, clone, cache transfer, and the first download into the workflow-specific cache directories. They do not establish the hosted timeout fit. All three workflows can run sequentially; measure the complete pipeline as well as each workflow, because queued time counts toward the unknown timeout.

An isolated Android copy with no `local.properties`, `ANDROID_HOME` or `ANDROID_SDK_ROOT` ran `spotlessCheck detekt` successfully in 1.04 s, with five tasks executed and no SDK download. That justifies a useful SDK-free workflow without provisioning `androidenv` or accepting SDK licences. The complete local `check:android` also passed; it is still a mandatory local merge check.

### Round-two minimal-PATH smoke

Replayed every workflow command sequentially in a disposable copy of the tracked workspace under `env -i`. `PATH` contained only an allowlist of utility symlinks corresponding to declared dependencies, not mise or general system directories. A real Node-based pnpm **11.27.0** launcher switched to **11.28.10**, generated the same shell-shim shape as the hosted failure, and installed the frozen lockfile into an isolated `.pnpm-store`. The inspected shim calls `readlink`, `dirname`, `sed` and `uname` before executing `pnpm.mjs`.

| Workflow / step | Local duration | Exit |
| -- | -- | -- |
| TS fresh-cache install | 15.79 s | 0 |
| `check:protocol` | 9.68 s | 0 |
| `check:server` | 2.61 s | 0 |
| `check:web` | 3.71 s | 0 |
| Infra warm install | 1.43 s | 0 |
| `check:infra` | 3.07 s | 0 |
| `check:brand` | 1.92 s | 0 |
| Android Java version | 0.03 s | 0 |
| Android `spotlessCheck detekt` | 4.63 s | 0 |

Local versions were Node 26.10.0, selected pnpm 11.28.10, Python 3.9.6 and Temurin 17.0.20.1. Android had no SDK configuration and used the unchanged normal Gradle home, not a temporary directory. The smoke used macOS utility implementations; macOS shell default-path lookups and absolute interpreter paths are not isolated by `PATH`, so this is not a NixOS/Linux sandbox or proof of hosted success. The temporary workspace was removed after verification.


### Toolchain, caches and validation

* `scripts/ci/check.sh` owns the lane commands; mise tasks and workflows call the same wrapper. Every existing task and the root `check` dependency list remain intact. No workflow runs `mise install` or requires mise.
* TS and infra use the documented `nixpkgs/nixpkgs-unstable` registry syntax with `nodejs_26` and `pnpm_11`. PR #9 confirmed Node 26.13.0. Node's major matches mise; its exact patch depends on the runner's nixpkgs revision and is printed in the install step.
* [Upstream `pnpm_11`](https://github.com/NixOS/nixpkgs/blob/master/pkgs/development/tools/pnpm/default.nix) currently supplies 11.27.0, versus the repo's 11.28.10. Keep pnpm's package-manager version management enabled: the Node-based 11.27.0 launcher successfully selected 11.28.10 and installed the lockfile in the round-two minimal-PATH smoke. `PNPM_HOME` remains inside the cached workspace so the selected version survives fresh Nixery step containers. The next hosted install remains to be checked.
* Every pnpm/Gradle workflow explicitly includes bash, coreutils, gnused, gnugrep, findutils, which and gawk. coreutils supplies the shim's `readlink`/`dirname`/`uname`; gnused supplies `sed`. TS also includes `python3` for the vector cross-check. Infra includes git for brand comparisons, `docker-client` (with Compose), shellcheck, and hadolint. There is currently no Dockerfile to lint or build; Docker build checks belong to the Dockerfile issue, not ENG-277.
* Android adds `jdk17` and curl/unzip for the wrapper and uses the common shell utilities for its `xargs`/`sed` launcher commands. Its explicitly workspace-backed `GRADLE_USER_HOME` is not a temporary directory. Only Gradle's `caches` and `wrapper` directories are archived.
* pnpm caches `.pnpm-store` and `.pnpm`, hashed by `pnpm-lock.yaml`. Gradle hashes `apps/android/gradle/libs.versions.toml` and `apps/android/gradle/wrapper/gradle-wrapper.properties`. All entries use `fallback: true`; every image includes `gnutar` and `zstd` for cache archives.
* `check:infra` parses workflow YAML with `scripts/ci/validate-workflows.ts`. It checks common, trigger/schedule, clone, cache, step and engine-specific key lists from the [Tangled workflow reference](https://tangled.org/docs/spindles/workflows/), including the differing dependency shapes. Registry names, environment variable names and NixOS option maps remain open-ended. This is a supported-key check, not a replacement for spindle validation.
* A temporary workflow containing unsupported top-level `timeout` made `mise run check:infra` exit 1 with `unsupported key "timeout"`. Removing it restored exit 0. Fifteen throwaway validator scenarios also covered valid engines/schedules, nested unknown keys, dependency shape, duplicate keys, invalid YAML and the acceptance of ignored NixOS options on non-NixOS microVM images.

### Lead's hosted verification round

1. Push round two and resubmit PR #9; verify all three workflows appear and pass. Record resolved tool versions, cold totals, then a warm-cache rerun with per-lane and per-workflow durations in the tables above. Do not mark a lane confirmed CI until this evidence exists.
2. If Linux brand output differs, mark full `check:brand` local-only and remove its CI step; do not re-record generated assets merely to make Linux green. Keep the useful infra workflow.
3. If any group cannot fit the observed hosted limit (including queue time), mark the affected lane local-only with the measured reason and retain a workflow only for a useful subset.
4. Push a deliberately failing check commit, observe a red pipeline, then revert it in the next round and observe green. This lead-only acceptance test is separate from the local validator failure proof.
5. Before merging, run full `mise run check:android` locally and every lane still marked pending or local-only. e2e coverage is outside ENG-277.


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
| `nixery` steps have no Docker. | Use `microvm`, `image: nixos`, and `virtualisation.docker: true` for Docker. |
