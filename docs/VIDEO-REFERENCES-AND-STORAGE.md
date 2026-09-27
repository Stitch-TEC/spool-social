# Video references and storage direction

September 27, 2026. This is a bounded implementation/decision record, not proof of deployment.

## Decision: linked review first

Keep originals with the client's existing file provider for now. Use an individual file's HTTPS
sharing link in a Spool draft, with a descriptive title/version and the intended caption. A local
path such as `/Users/.../clip.mov` cannot give reviewers on other devices access. A screenshot
helps identify a clip but cannot replace the playable source or prove which version was approved.

The first convenience update deliberately uses the existing **draft text**, not a new attachment
field. An explicit editor helper inserts the link; the review pane offers external link actions.
Google Drive, OneDrive/SharePoint, Dropbox, YouTube/Vimeo and direct video URLs are recognized.
Recognition does not verify that a URL exists, contains a video or is accessible to the reviewer.
No external page, preview, metadata or video is automatically fetched or embedded by the helper.

Important limits:

- The inserted link is part of the caption/content. It counts toward existing limits and travels
  with copy, export, AI content processing and publishing/email handoffs that use that content.
  Do not insert a secret or a link whose recipients must not receive access.
- Changing this text uses the existing editorial save, recovery and approval-reset behavior.
  Approval records the draft text and link, **not immutable video bytes**. A file can change behind
  an unchanged provider link. Use explicit versioned filenames and new links for new cuts.
- Sharing permissions remain with the file provider. Spool's private stage is not a private file
  store and does not grant viewers access to the source. Verify access as the intended reviewer.
- The existing image cover can provide a thumbnail only when that image is appropriate for the
  current public media-serving route. Do not upload confidential frames to it. Private posters
  need the later private asset design below.
- Existing platform readiness rules remain in place, including Instagram's image requirement.
  A link does not become a native social video or make unsupported automatic video publishing work.
- No bulk creation, client invitation, review submission, provider authorization, rules deployment,
  storage provisioning, migration or automatic video retry is included.
- Curated Media Library video pointers are a separate feature. Their existing provider support,
  50-item combined cap and mutation limitations are unchanged by this draft-text convenience.

## A workable first batch

1. Keep a stable source folder and version names, for example `topic-001-v01.mp4`.
2. Create one draft per video so approval and requested changes are unambiguous. Add the matching
   title, intended platform/caption and individual sharing link, not just a folder or local path.
3. Check the link as the reviewer, using the provider's intended audience settings. Keep a copy of
   the original. Do not broadly publish a private file merely to get past a permission prompt.
4. Save privately, inspect the draft, then deliberately send for review when ready. Comments can
   refer to a timestamp such as `00:23`; this version does not add timeline annotations.
5. For a new cut, use a new version/file link and edit the draft. Re-review before delivery.
   Do not silently overwrite an approved file at the same URL.

For a Google-to-Microsoft move, first establish the destination folder and reviewer access, copy
the originals, check matching versions, then deliberately replace draft links and re-review.
Keep the old sources until destination playback and access have been checked. Provider migration
is not part of this code release. Microsoft sharing options depend on the tenant and site policy;
Google file owners also control sharing. See [Microsoft sharing permissions](https://learn.microsoft.com/en-us/sharepoint/modern-experience-sharing-permissions)
and [Google Drive file sharing](https://support.google.com/drive/answer/2494822).

## Next: real attachments, separate from publishable text

Prefer one primary video per draft initially: durable asset ID, source provider, link, display
title, explicit version, optional poster and caption/transcript metadata. Keep the canonical client
slug and tenant authorization on every operation. Do not use a filename/path as an authority key.

This needs a coordinated change, not an editor-only property:

- Browser editor mapping, durable create journal, interrupted-save reconciliation and existing-post
  transaction guards must preserve the attachment/version.
- Browser and Worker draft identities and approval-reset checks must include the attachment.
- Firestore member/guest allowlists, API projections, create/PATCH payloads, clone/import/CSV/undo
  and suggestion promotion need aligned tests before any rules cutover.
- POM review and Spool review must show the same asset/version. Sender and publish handoffs must
  intentionally render a link or reject unsupported media, never silently drop it.
- Platform readiness must distinguish a reference from a playable/native publishable asset.
- Link replacement is an explicit editorial change. External bytes remain mutable unless stored
  and identified by an immutable owned version; labels alone are not cryptographic proof.

## Later storage: Cloudflare-first, only when useful

| Choice | Good fit | Trade-off |
| --- | --- | --- |
| Client's Drive / OneDrive / SharePoint | Linked review now, no new video service | Provider permissions and migration can break links; no Spool-controlled immutable version |
| Private R2 originals | Owned masters, portability and stable version identities | Requires tenant-safe direct/resumable uploads, authorized download, quotas and lifecycle/recovery; storage alone is not a transcoding player |
| Cloudflare Stream review copies | Consistent in-app playback across devices | Paid by stored/delivered minutes; requires authorized upload and signed playback; not a substitute for a deliberate master-file policy |

Current published price reference, checked September 27: R2 Standard storage is $0.015/GB-month,
with request charges and no Internet egress charge; its Standard free tier includes 10 GB-month.
Thus 100 GB-month is roughly $1.35 storage if that entire account-level free allowance is available,
excluding requests and other services. [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

Stream storage capacity is bought in $5/month increments per 1,000 stored minutes; delivery is
$1 per 1,000 delivered minutes. For example, up to 1,000 stored minutes plus 2,000 delivered minutes
is $7 for those dimensions, not a whole-platform quote. [Stream pricing](https://developers.cloudflare.com/stream/pricing/).
Private playback must explicitly require signed URLs; Stream video IDs alone are public by default.
[Stream access protection](https://developers.cloudflare.com/stream/viewing-videos/securing-your-stream/).

Recommendation: do not copy every client video into both R2 and Stream now. Learn actual file sizes,
durations, review volume and retention needs first. If linked review proves awkward, add private
versioned assets, then Stream previews where justified. Keep upload requests out of JSON/base64;
require bounded/resumable transfer, quotas, receipt/idempotency and uncertain-result reconciliation.
Private originals, posters and transcripts must not reuse the public image route or enter shared
AI context automatically. No new paid service is enabled by this plan.

## Acceptance, rollout and rollback

The convenience slice changes only frontend link parsing/presentation and uses existing content
editing. Test unsafe/overlong URLs, provider boundaries, query preservation, duplicate handling,
read-only controls, recovery and approval identity, mobile layout and keyboard focus. Run the full
application suite, lint/build, unchanged-rule CI and independent native-browser checks before merge.
Verify exact deployed browser/Worker artifacts and unchanged configuration after a permitted merge.

Roll back source if the editor or review pane regresses, without clearing browser recovery stores.
Inserted links are ordinary text and remain readable in the preceding build; no data/rules rollback
is needed. No automatic resubmission or cleanup should accompany rollback. External access and
physical-device playback still require a real reviewer check once a source file is supplied.
