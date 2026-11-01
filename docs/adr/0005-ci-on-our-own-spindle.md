# 0005. CI on our own spindle

- **Status:** accepted
- **Date:** 2026-11-01
- **Issue:** ENG-470 (project Spindle); trigger ENG-460
- **Spec:** `docs/SPEC.md` §16.4 (Tangled, CI and the GitHub mirror)

## Context

Since 2026-11-01 06:08 UTC, Tangled's hosted spindle has denied every Pneumo pipeline. Its `nixery` engine requests 6144 MiB per job, and the hosted per-repo workflow quota is 4096 MiB (ENG-460). Pneumo's lane workflows peak at 3.65 GiB locally, so the problem is the fixed request size, not our workloads. We can't change either value on the hosted spindle. Every Pneumo PR was blocked as a result.

## Decision

Pneumo's CI runs on our own spindle, `spindle.demi.dev`, built and operated in project Spindle ([tangled.org/demi.dev/spindle](https://tangled.org/demi.dev/spindle), its ADR 0001):

- a mill on Railway (its own project `spindle`) receives events and holds the queue, the logs and the identity `did:web:spindle.demi.dev`;
- a `nixery` executor runs on a NixOS VM on the owner's home server. It has 4 seats, a 15-minute workflow timeout, and 6144 MiB per job. Firewall rules keep CI jobs off the home LAN.

Repo **Settings → Pipelines** selects `spindle.demi.dev`. The workflow files don't change.

## Consequences

- CI works again, and Pneumo PRs are no longer blocked by the hosted quota.
- Up to 4 workflows run at once, instead of one after another. A full pipeline gets faster, but tests with tight timeouts can flake under load (ENG-497).
- The timeout is 15 minutes of run time. The old "queue-inclusive 5 minutes" planning budget no longer applies.
- CI is up only while the owner's home server and its network are up. While the executor is offline, the mill queues jobs. The fallback is in `docs/agents/tangled.md`.
- We now operate a CI service: upgrades, token rotation and backups follow the spindle repo's `docs/runbook.md`. It costs about $5/month on Railway.
- The CI history from the hosted spindle was dropped when the spindle was switched.
