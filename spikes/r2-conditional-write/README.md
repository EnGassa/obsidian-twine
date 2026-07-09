# R2 conditional-write spike (Phase 0, Spike 2)

Confirms empirically that Cloudflare R2's S3-compatible API honors `If-Match` /
`If-None-Match` conditional writes with a 412 on mismatch — the primitive the
sync engine relies on (`src/store/s3-client.ts`, `PreconditionFailedError`) to
catch two of your own devices racing a write to the same file, without a
coordinating server.

Public docs already confirm this is supported (see the plan), but this spike
exercises it against your actual bucket before the real engine depends on it.

## Prerequisites

1. A Cloudflare R2 bucket (any bucket you intend to use, or a scratch one).
2. An R2 API token scoped to that bucket (Cloudflare dashboard → R2 → Manage API tokens).

## Run

```
R2_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com \
R2_BUCKET=<your-bucket> \
R2_ACCESS_KEY_ID=<key> \
R2_SECRET_ACCESS_KEY=<secret> \
pnpm exec tsx spikes/r2-conditional-write/spike.ts
```

## What it does

Creates one throwaway object (`selfsync-spike-test`), runs through create /
conditional-update / racing-stale-write checks, verifies the final content is
correct, and deletes the object afterward. Safe to run against a bucket you
plan to actually sync to.

## What a pass looks like

All seven numbered steps print `OK`, ending with:
```
All checks passed: R2's S3 API enforces If-Match/If-None-Match conditional writes correctly.
```

If anything says `UNEXPECTED`, conditional-write race protection is not
working as assumed — stop and re-check the `s3-client.ts` signing logic
(likely culprit: conditional headers not being included in the signed
header set) before trusting the sync engine's race safety.
