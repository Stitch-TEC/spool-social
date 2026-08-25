# Spool media hardening rollout (v2 cache key)

This runbook is required for the media-ingestion hardening that introduced
`/media/v2/<key>`. It is deliberately non-destructive: do not delete or rewrite
R2 objects while auditing them.

## Why code deployment is not enough

Legacy `/media/<key>` responses were sent with a one-year `immutable` cache
policy. A Worker change cannot recall a response already held by a browser or a
Cloudflare cache. The new code therefore:

- emits only `/media/v2/<key>` for new media;
- rewrites legacy Firestore cover-image references and rendered inline Markdown
  images to v2 at read/render time, without mutating the approved payload;
- redirects an origin cache miss on `/media/<key>` to v2 with `no-store`;
- validates v2 GET bodies from magic bytes and derives the response MIME from
  those bytes;
- trusts a HEAD response only when the object carries the validation metadata
  written by the new ingestion path. Legacy HEADs download/no-store.

Those controls prevent new application requests from reusing the old cache key.
They do **not** invalidate old Cloudflare/browser entries by themselves.

## Deployed hostname inventory (read-only, 2026-08-24)

The deployed Worker/config and live health probes identify two reachable Spool
hostnames:

| Role | Hostname | Deployment evidence | Media behavior after this PR |
|---|---|---|---|
| canonical | `spool.stitchtec.dev` | custom-domain route; `/api/health` returned 200 | the only `PUBLIC_ORIGIN`; every new/output URL uses it |
| legacy alias | `spool.kist.workers.dev` | `workers_dev = true`; `/api/health` returned 200 | accepted only through `LEGACY_MEDIA_ORIGINS`, then rewritten to the canonical host |

No request host or arbitrary `/media/` origin is trusted. The SPA build pins the
same pair through `VITE_PUBLIC_ORIGIN` and `VITE_LEGACY_MEDIA_ORIGINS`. Before the
production rollout, re-open the Cloudflare Worker Routes/Custom Domains view and
record every active custom domain, route, workers.dev address, and preview alias.
If anything beyond the two rows above is active, **stop**: add it explicitly to
the legacy-input allowlist only if it historically served Spool media, include it
in the purge/verification matrix below, and have that change reviewed. Never make
the allowlist match the incoming Host dynamically.

## Required rollout sequence

1. Complete the strict legacy-ID inventory gate and guarded review-stage
   backfill/audit in `REVIEW_STAGE_ROLLOUT.md`; this must happen before the
   application merge.
2. Merge the reviewed PR. The Worker and SPA auto-deploy from `main`.
3. Confirm new uploads and generated images return `/media/v2/` URLs.
4. Immediately reauthenticate Firebase and deploy `firestore.rules` manually,
   then run the approve/request-changes smoke test in `SHARE_LINKS.md`. Existing
   actions work under the old rules, but the security constraints stay inactive
   for every minute this step is delayed.
5. Complete the R2 raster audit below. Save its inventory/results outside the
   bucket; do not alter objects during the audit.
6. Purge cached legacy URLs at Cloudflare for **every active hostname** in the
   verified inventory—currently both `spool.stitchtec.dev` and
   `spool.kist.workers.dev`:
   - prefer a hostname-scoped purge for each hostname if the account supports it;
   - otherwise generate both absolute forms of every audited key,
     `https://<hostname>/media/<key>`, and purge the complete URL set for each
     host, including all known query-string cache-key variants;
   - the custom domain and workers.dev cache surfaces are separate checklist
     rows. A successful custom-domain purge does not prove the workers.dev copy
     is gone. If the account tooling cannot target workers.dev cache, escalate to
     Cloudflare/support and keep the finding open; do not mark an unpurged alias
     as covered by the origin redirect;
   - use a zone-wide purge only after considering its effect on the public
     website and other `stitchtec.dev` apps.
7. Verify each hostname separately. For at least one raster and one unsupported
   legacy key per active hostname, record response status and cache headers:
   - `/media/<key>` must no longer return old bytes; its miss must be `308` with
     an absolute `Location: https://spool.stitchtec.dev/media/v2/...` and
     `Cache-Control: no-store`;
   - the canonical v2 GET must return a canonical raster MIME or a no-store
     binary attachment for non-raster bytes;
   - a request arriving through `spool.kist.workers.dev` must still redirect to
     the exact canonical custom-domain v2 URL, never emit workers.dev.
Do not mark the media finding closed until steps 5–7 are recorded. None of these
production operations were performed by the code PR.

## Optional workers.dev shutdown (separate approval/deploy)

Disabling `workers_dev` reduces the future public-host surface, but it is a live
routing change and is intentionally **not** bundled into this source fix. After
the R2 audit, both-host cache purge, stored-reference migration verification, and
caller inventory are complete, request separate approval to change
`workers_dev = false` and deploy it. Verify the workers.dev health/media routes
then stop resolving while the custom domain remains healthy.

Keep `https://spool.kist.workers.dev` in the legacy reference allowlist until all
stored absolute references have been inventoried/migrated. Disabling the route
does not erase Cloudflare/browser copies already cached under that hostname and
does not remove the required purge or residual-browser-cache steps.

## Non-destructive R2 raster audit

Create a complete inventory of `spool-media` through the Cloudflare dashboard,
R2's S3-compatible listing API, or an approved inventory export. Cover every
object under `generated/` and every non-video object under `library/`.

For each key, download a copy and record only:

- key, byte size, and upload timestamp;
- stored `Content-Type` and existing custom metadata;
- detected signature: JPEG (`FF D8 FF`), PNG, WebP (`RIFF…WEBP`), GIF87a/GIF89a,
  or unsupported;
- whether the stored MIME agrees with the detected signature;
- whether Firestore/content-index references the key.

For every Firestore/content-index reference, also record whether it is relative,
canonical-host absolute, workers.dev absolute, or an unrecognized origin. An
unrecognized origin must remain untouched until separately investigated; it is
not automatically Spool media merely because its path contains `/media/`.

Run an end-of-audit inventory delta so objects created during the audit are not
missed. New writes should carry `rasterValidated=v2` plus a canonical
`rasterMime`; absence of that stamp means “legacy/untrusted for HEAD,” not proof
that an object is malicious.

If unsupported or mismatched objects are found:

1. keep the original object and audit record intact;
2. identify every reference before changing anything;
3. confirm that v2 GET serves it as `application/octet-stream` attachment;
4. propose quarantine/re-ingestion separately, with a backup and explicit
   operator approval. Never bulk-delete from this runbook.

## Residual browser cache

A Cloudflare purge does not clear a browser's already-fresh immutable entry on
either active hostname.
The SPA's runtime v2 rewrite avoids that entry for normal Spool use, but a direct
bookmark, an old email, or a third-party embed of `/media/<key>` can continue to
display its locally cached bytes until expiration or that user clears site data.
For the internal pre-launch testers, hard-refresh/clear site cache after rollout.
Record this residual explicitly; origin code cannot guarantee its removal.

## Rollback

Do not roll application references back to unversioned `/media/<key>`. If the v2
route has a defect, fix or temporarily disable media rendering while preserving
the versioned cache boundary. Rolling back Firestore rules restores permissive
guest actions but reopens the documented review-write security gap.
