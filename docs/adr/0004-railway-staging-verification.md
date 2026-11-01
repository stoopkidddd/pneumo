# 0004. Railway staging results: direct uploads and deploy handoff

- **Status:** accepted
- **Date:** 2026-11-01
- **Issue:** ENG-271
- **Spec:** `docs/SPEC.md` §16.3, §18.1, §18.2; [ADR 0001](0001-railway-deploy-config.md)

## Context

Spec §18 left two Railway questions for the staging deploy: whether Railway Buckets
accept `PutBucketCors` and browser presigned PUTs (§18.1), and whether a redeploy
loses pushes written around the handoff between instances (§18.2). ADR 0001 chose
overlap 0 s and draining 15 s and said the lead would apply the service settings
through Railway Infrastructure as Code.

The lead created project `pneumo` on the owner's Railway account on 2026-11-01:
bucket `pneumo-files` in `iad`, service `pneumo` from the GitHub mirror in
`us-east4`, environments `production` and `staging` (each with its own bucket
instance and `*.up.railway.app` domain).

## Decision

1. **Uploads (§18.1): direct mode works.** With `UPLOAD_MODE=auto`, both
   environments logged "Bucket CORS configured and read back; using direct uploads".
   The staging smoke passed every step, including a 2 MB file round trip. A real
   Chromium signed in to staging and uploaded a 256 KiB file: the presigned PUT to
   the bucket origin returned 200, the push was created (201), and the console had
   no CORS errors. Keep `auto`; proxy mode stays the fallback.
2. **Deploy handoff (§18.2): keep overlap 0 s and draining 15 s.** In staging, a
   listener stayed connected while a sender posted a note about every 2 s from
   04:23:24 to 04:28:26 UTC; a redeploy started at 04:24:00, the new deployment was
   live at 04:24:18 and the old one was removed at 04:24:37. All 150 notes were
   accepted (0 send failures) and all 150 arrived at the listener exactly once (0
   missing, 0 duplicate ids). The listener's socket closed when the old instance
   stopped and reconnected about 3 s later. The test didn't record which instance
   wrote each push, so it shows no loss end to end rather than isolating the
   30-second re-list path.
3. **WebSocket through Railway's proxy:** an idle listener stayed connected for
   about 11 minutes (one `/api/ws` upgrade, 672 s) until the redeploy, and a note
   sent after 10 idle minutes arrived live, so the 60 s heartbeat keeps sockets open.
4. **Settings applied through the Railway API, not committed IaC.** The lead set
   ADR 0001's settings (Dockerfile build, healthcheck `/api/health`, 1 replica in
   `us-east4`, restart on failure with 10 retries, overlap 0 s, draining 15 s) and
   the §12.3 bucket-reference variables with the Railway MCP tools. A committed
   `.railway/railway.ts` would add the Railway SDK as a repo dependency to manage
   one service; the template (ENG-273) carries the same settings for other users.

## Consequences

- §18.1 and §18.2 are answered; the spec now points here.
- Production's settings live in the Railway project, not in the repo. Anyone changing
  them must update this ADR and the template.
- Staging keeps its own setup token (a Railway variable, value stored only on the
  owner's Mac), was reset with `cli.js reset --yes` after the tests, and sleeps when
  idle to save cost.
