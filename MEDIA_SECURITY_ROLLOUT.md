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
They do **not** invalidate an already-fresh browser entry by themselves. If
Cloudflare edge caching is introduced later, the applicability gate below also
becomes mandatory.

## Deployed hostname inventory (read-only, corrected 2026-08-25)

The deployed Worker/config and live health probes identify two supported Spool
hostnames. The 2026-08-25 pre-release audit also found Cloudflare's public
per-version Preview URLs enabled; retained versions therefore remained reachable
at `<version-prefix>-spool.kist.workers.dev`. Those URLs are not an application
route or a supported test surface. `wrangler.toml` now pins `preview_urls = false`
so a later deploy cannot silently re-enable them.

| Role | Hostname | Deployment evidence | Media behavior after this PR |
|---|---|---|---|
| canonical | `spool.stitchtec.dev` | custom-domain route; `/api/health` returned 200 | the only `PUBLIC_ORIGIN`; every new/output URL uses it |
| legacy alias | `spool.kist.workers.dev` | `workers_dev = true`; `/api/health` returned 200 | accepted only through `LEGACY_MEDIA_ORIGINS`, then rewritten to the canonical host |
| unsupported previews | `<version-prefix>-spool.kist.workers.dev` | pre-release audit found at least two retained versions publicly reachable | must be disabled before the maintenance window; never accepted as a media origin |

No request host or arbitrary `/media/` origin is trusted. The SPA build pins the
same pair through `VITE_PUBLIC_ORIGIN` and `VITE_LEGACY_MEDIA_ORIGINS`. Before the
production rollout, require the Worker subdomain API/dashboard to report
`enabled=true, previews_enabled=false`, and prove known version-preview hosts no
longer route. Then re-open the Cloudflare Worker Routes/Custom Domains view and
record every active custom domain, route, and workers.dev address. If any preview
alias remains active, **stop**. If any other production hostname is active, add it
to the legacy-input allowlist only if it historically served Spool media, include
it in the verification matrix below, and have that change reviewed. Never make the
allowlist match the incoming Host dynamically.

## Edge-cache applicability correction (2026-08-25)

The original runbook treated the legacy response's one-year `Cache-Control`
header as proof that Cloudflare had cached the bytes at the edge. That was too
broad. Cloudflare's current Workers cache model documents Worker-response caching
through Worker cache configuration / entrypoint caching and the Cache API; a
cache fill is observable through `CF-Cache-Status`. See
<https://developers.cloudflare.com/workers/cache/configuration/> and
<https://developers.cloudflare.com/workers/reference/how-the-cache-works/>.

The pre-release audit proved all of the following for Spool:

- no `[cache]` / `cache.enabled` config (`cache_options` is absent/unset in the live Script API);
- no Cache API or cache-config calls anywhere in Worker history;
- the legacy media route reads R2 directly and returns the body without a `fetch()` subrequest;
- repeated legacy responses on both supported hosts carried neither
  `CF-Cache-Status` nor `Age`.

Therefore there is no Cloudflare edge object to purge for the legacy media
responses; edge purge is a documented **not-applicable / zero-cache** step. The
one-year header did create a browser-cache residual, which remains covered below.
If any future preflight finds `cache.enabled`, a Cache API/fetch cache path,
`CF-Cache-Status`, `Age`, or a matching zone cache rule, zero-cache is no longer
valid: stop and execute the complete per-host purge path before lifting the freeze.

## Required rollout sequence

1. Complete the strict ID/owner/tenant inventory and guarded review-stage +
   `updatedAt` backfill/audit in `REVIEW_STAGE_ROLLOUT.md`. Deploy
   `firestore.indexes.json` and wait until the `posts(uid, updatedAt DESC)` index
   is READY. Disable public Preview URLs while keeping the production
   `workers.dev` alias enabled; prove known preview hosts no longer route and keep
   `preview_urls = false` in the reviewed deploy config. These are preconditions,
   not maintenance-window shortcuts.
2. Start the internal review freeze: no send/hold/approve/request-changes/
   resubmit actions. Deploy the companion changes in the approved order:
   **feedback-worker first → POM second → final Spool third**. A temporary
   fail-closed old POM Content card is accepted. Spool auto-deploys from `main`;
   do not treat its green deploy as completion.
3. Immediately reauthenticate Firebase and deploy `firestore.rules` manually:

   ```bash
   firebase deploy --only firestore:rules --project spool-social
   ```

4. Run the field/revision/error/pagination and private/in-review smoke checks in
   `REVIEW_STAGE_ROLLOUT.md` and the guest/member checks in `SHARE_LINKS.md`.
   Confirm new uploads, rendered Markdown media, list/get output, and generated
   images emit only canonical `/media/v2/` URLs. Keep the review freeze active.
5. Complete the R2 raster audit below. Save its inventory/results outside the
   bucket; do not alter objects during the audit.
6. Re-prove edge-cache applicability for **every supported hostname** in the
   verified inventory—currently both `spool.stitchtec.dev` and
   `spool.kist.workers.dev`. If the four zero-cache proofs above still hold,
   record Cloudflare edge purge as not applicable for each host. Otherwise purge
   every affected host before continuing:
   - prefer a hostname-scoped purge for each hostname if the account supports it;
   - otherwise generate both absolute forms of every audited key,
     `https://<hostname>/media/<key>`, and purge the complete URL set for each
     host, including all known query-string cache-key variants;
   - the custom domain and workers.dev cache surfaces are separate checklist
     rows. A successful custom-domain purge does not prove the workers.dev copy
     is gone. If edge caching is evidenced and the account tooling cannot target
     workers.dev cache, escalate to Cloudflare/support and keep the finding open;
     do not mark an unpurged alias as covered by the origin redirect;
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
Do not lift the review freeze or mark the media finding closed until steps 5–7
are recorded. None of these production operations were performed by the code PR.

## Optional workers.dev shutdown (separate approval/deploy)

Disabling `workers_dev` reduces the future public-host surface, but it is a live
routing change and is intentionally **not** bundled into this source fix. After
the R2 audit, both-host edge-cache applicability record (plus any purge that the
record requires), stored-reference migration verification, and caller inventory
are complete, request separate approval to change
`workers_dev = false` and deploy it. Verify the workers.dev health/media routes
then stop resolving while the custom domain remains healthy.

Keep `https://spool.kist.workers.dev` in the legacy reference allowlist until all
stored absolute references have been inventoried/migrated. Disabling the route
does not erase browser copies already cached under that hostname. If edge caching
is ever evidenced, route shutdown also does not replace the applicable purge.

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

An edge purge, when applicable, does not clear a browser's already-fresh immutable entry on
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
