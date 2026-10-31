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

The PR contains exactly the branch's commits.

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
For Node 26, use a versioned nixpkgs attribute or install Node with mise.
The CI issue must confirm the exact attribute name, such as `nodejs_26`.

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

The CI issues will fill in lane coverage.

| Lane | CI or local-only |
| -- | -- |
| pneumo-protocol | TBD (ENG-277 / ENG-278) |
| pneumo-server | TBD (ENG-277 / ENG-278) |
| pneumo-web | TBD (ENG-277 / ENG-278) |
| pneumo-android | TBD (ENG-277 / ENG-278) |
| pneumo-infra | TBD (ENG-277 / ENG-278) |
| pneumo-brand | TBD (ENG-277 / ENG-278) |

## Known Tangled quirks

| Quirk | Operator action |
| -- | -- |
| `tang` 0.0.3 cannot resolve `org.tangled.repo.declaration` repos. | Use the web UI as specified in the `tang` section. |
| The comments panel does not refresh after sending. | Reload before counting a unique heading to prevent duplicate comments. |
| `form_input` does not enable **Send comment**. | Click into the textarea and press `cmd+Enter`. |
| Merging applies the patch as new commits, so commit IDs on `main` differ from the branch. | Delete the source branch after merging. |
| Each workflow file has exactly one engine. | Use two files to test two engines. |
| The spindle rejects unknown workflow keys. | Use the workflow validation report. |
| `nixery` steps have no Docker. | Use `microvm`, `image: nixos`, and `virtualisation.docker: true` for Docker. |
