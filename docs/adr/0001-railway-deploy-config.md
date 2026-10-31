# 0001. Apply Railway deploy settings outside config as code

- **Status:** accepted
- **Date:** 2026-10-31
- **Issue:** ENG-267
- **Spec:** `docs/SPEC.md` §4, §16.3, §18.2

## Context

The spec calls for a repository `railway.json` containing build and deploy settings.
Railway's [Config as Code documentation](https://docs.railway.com/config-as-code)
now deprecates that feature: new services cannot opt in, and existing files stop
being read on 2026-12-01. The replacement,
[Infrastructure as Code](https://docs.railway.com/infrastructure-as-code), is applied
with the Railway CLI (`railway config plan/apply`), not read during deploys.
The lead verified these constraints on 2026-10-31.

## Decision

Ship the root `Dockerfile`, which Railway auto-detects, and no `railway.json`.
The lead applies Railway service settings through Infrastructure as Code in
ENG-271; ENG-273 sets the same settings in the deployment template:

- Dockerfile build; healthcheck `/api/health`.
- One replica; restart on failure.
- Recommended overlap: **0 seconds**. The new instance boot-loads the push index
  before listening, so readiness replaces a deliberate period of dual writers.
- Recommended draining: **15 seconds**. After SIGTERM, the server closes WebSockets
  with 1012 and allows up to 10 seconds for in-flight requests (§12.7); five seconds
  of margin avoids platform termination before that deadline.

Zero configured overlap does not eliminate in-flight writes by the draining old
instance after the new instance's boot snapshot. The 30-second re-list (§12.2)
catches those records and broadcasts them. ENG-271 must verify this handoff in
staging as required by §18.2, including WebSocket reconnects after 1012.

## Consequences

There is no Railway configuration file in the repo for this issue. Deploys build
the image without depending on a deprecated config reader. ENG-271 and ENG-273
own the service and template settings; the Dockerfile alone does not configure
healthchecks, replica count, restart policy, overlap, or draining.
