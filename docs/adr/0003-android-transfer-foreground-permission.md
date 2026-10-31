# 0003. Declare the Android transfer foreground permission

- **Status:** accepted
- **Date:** 2026-10-31
- **Issue:** ENG-266
- **Spec:** `docs/SPEC.md` §14.2

## Context

§14.8 requires WorkManager uploads with a foreground progress notification.
Explicit downloads in §14.9 also use foreground transfer work. The manifest merges
WorkManager's foreground service with type `dataSync`, but §14.2 omitted
`FOREGROUND_SERVICE_DATA_SYNC`. Android 14 (API 34) and later require this
permission when starting a foreground service of that type.

## Decision

Add `FOREGROUND_SERVICE_DATA_SYNC` to §14.2's permission list for foreground file
uploads and downloads. Keep the manifest declaration and WorkManager's `dataSync`
service type. The persistent connection remains `remoteMessaging`.

## Consequences

The spec now describes the permission already needed by the transfer workers on
API 34+. This is a manifest permission, not an additional runtime permission
prompt. It does not change notification permission handling, initiate automatic
downloads, or expand access to shared storage.
