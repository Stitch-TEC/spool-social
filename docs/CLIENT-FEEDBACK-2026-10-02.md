# Spool client feedback — October 2, 2026

Status: first repair batch #138 is merged and verified live (`8f67844f`, Worker `55456a8c-39ba-4e3a-b5d6-c0a0c6226d64`). The next review-details compatibility foundation is prepared, not yet released; authoring is off. Owner requested review and fixes after a client-role pilot. Preserve all existing drafts, media, review history and dates; no bulk cleanup is authorized merely by a bug report. Client-specific feedback and QA remain in private suite evidence, not this public repository.

## First release: correct saves and trustworthy controls

| Report | Verified finding | Prepared correction / limit |
| --- | --- | --- |
| Blank new Schedule fails and wedges recovery | The save boundary correctly emits null, but the create journal required strings and transport had no null encoding. Prospective validation also poisoned recovery state. | Accept null only for scheduledDate, encode/decode exact Firestore null, validate before queuing, keep the same reserved identity and uncertainty guards. |
| Opening an undated thread dates it now | Both initialization paths invented the current time. | Default to an empty optional Schedule; preserve existing valid dates in local time. No automatic correction of the accidentally dated real thread. |
| Empty recovery blocks every new draft | Every retained draft required Restore, including never-prepared copies with no authored work. | Continue a genuinely empty never-prepared copy under its SAME reserved ID and revision. Meaningful, prepared, submitted, foreign or corrupt copies retain deliberate recovery gates. |
| Save greyed out without explanation | Multiple guards had no nearby accessible reason. | Concise visible reason connected to Save; correctable tag/date problems are not mislabeled save-identity failures. |
| Older threads open editable then deny Save | Member editor had no per-document admission. Actual February records and deployed-rule cause are not yet established. | Same-client/current-read admission plus live transaction checks; incompatible legacy records need operator attention. Published/archived member threads are read-only by conservative product policy, not a claim that Posted alone caused the reported permission denial. No raw permission-error instructions or role widening. |
| Video library cannot be selected | Picker filtered the library to images. | Images and supported video references listed separately; selecting video fills the explicit link tool, never imageUrl or the caption automatically. Existing caption-link behavior is clearly stated. |
| Indistinguishable video tiles | Tile displayed only provider/URL; manifest may have no human title. | Prefer existing title/label/name; otherwise show distinct provider + video ID or filename. Search observed metadata. No fetched title, thumbnail or duration claim. |
| Tags silently cut; feedback silently caps | Editor/save sliced tags; widget maxLength and slicing discarded pasted text. | Reject tags over 20 characters or 10 entries; show counters and retain pending input. Feedback retains full pasted text, shows count and blocks sends over existing 1,000-code-unit ingress limit. |
| Wrong platform default | New drafts always used Google Business. | Prefer the most-used supported platform observed in the selected canonical client's non-template, non-archived posts. Stable fallback when no evidence; not a connection/access test. |

No client content is rewritten by deploying these changes. Existing approval/reset and tenant-move transactions remain authoritative. UI checks are not server permission proof, locks, guaranteed cancellation after dispatch or durable storage immunity.

First-release acceptance: 1,677 application tests and 77 separate strict native Firestore permission/REST cases pass. Lint/build, both raw audits (zero), action pins, independent reviews and protected checks pass. Exact Worker/configuration and all 27 public files were verified; no client content or deployed rules changed. Native browser evidence has its documented provider/helper limits and does not certify physical devices or PWA behavior. Later preparation tests must not be substituted for this dated release record.

## Recommended next release: clean review media

The staged compatibility contract, authoring-off release gates and native recovery version-2 limits are now in [Review details rollout](REVIEW-DETAILS-ROLLOUT.md). This foundation is not an enabled editor feature or a rule deployment.

Highest-value product change: review media must be separate from publishable copy. Add bounded `reviewMedia` references with stable IDs, display labels and optional source-version notes. Provide a per-thread first-comment field. Keep caption, first comment and review attachments visibly distinct.

Define the complete storage, rules, journal, approval identity, AI input, export/import, guest review, POM preview and Sender/site handoff contract before enabling writes. Review-only links must be omitted from all publishing/copy serializers by default; a dedicated review export can include them explicitly. First comments require explicit destination support, never silently appended to captions. Linked files may change externally: approval covers the saved reference and text, not immutable video bytes.

Existing caption URLs must not be automatically stripped or moved. Offer a reviewed per-thread migration preview identifying the exact URL and resulting caption. Preview is not authorization to bulk-modify existing drafts. Keep Google Drive/OneDrive/SharePoint links provider-neutral during service migrations; machine-local paths are not a usable reviewer sharing method.

## Permission stage: Archive, Hold and staging

Client Archive is appropriate, but the current member rules do not allow that transition. Define a same-client archive transaction with fresh actor/read admission, updatedAt, prior-status provenance and preserved review history. Test foreign clients, guests, legacy records, retries, concurrent approvals and restore semantics. Archive is reversible retirement, not deletion or hiding only on one device.

Private staging needs a deliberate workspace-editor/author visibility model. Do not expose existing operator-private drafts to every member or present an unavailable action. Keep current member-save disclosure until a reviewed policy is activated. Separately introduce a durable Hold reason and fact-check checklist; enforce Hold at approval, scheduling and downstream handoff boundaries, not just via a tag or red badge.

These require a targeted rule review and current deployed-rule/account-shape evidence. The existing source-only rules changes from #137 remain unactivated; do not bundle them incidentally. No revoke/regrant workaround, new grant or access reset is part of this release.

## Agency workflow roadmap

1. Discoverable CSV/JSON templates and field reference. Dry-run every row before writes, show client/platform/date/tag/media errors, pin the import to the actor and canonical tenant, retain stable idempotent row identities. Prefer operator staging until member staging has its own policy.
2. Bounded bulk actions with explicit selection and preview: add/remove tags, archive and shift planned dates. Preserve per-row unknown outcomes; do not blindly retry whole batches. Cadence should propose dates/time zone and conflicts before applying, not promise social publication.
3. Multi-image carousel/document assets: one logical bundle with ordered slides, per-slide alt text/caption and swipeable review. Treat item-count and byte quotas separately. PDF preview needs safe parsing/rendering, type/size checks and resource budgets; it is not a generic executable embed.
4. A parent content idea with platform variants and stable IDs. Shared visual/review intent can reduce duplicate work, but each variant needs an exact reviewed payload/revision. A shared approval covers only the displayed selected variants; edits or late-added variants need re-review. Optional per-variant overrides must be explicit. Export one row per variant with post_id/variant_id; do not silently merge existing near-duplicate posts.
5. Reels/TikTok/Shorts/YouTube drafts with channel-specific title, description, hashtags and visual guidance. Channel validation is versioned guidance, not publishing authorization. Keep 9:16 safe-area overlays illustrative because device/platform chrome varies. Hashtag recommendations are adjustable preferences, not fabricated platform limits.
6. Optional bounded metadata enrichment and usage references. Use allowlisted provider endpoints, no arbitrary server URL fetch, fail safely for private/unavailable metadata, preserve custom labels and avoid exposing private signed URLs in logs. Usage counts must label their loaded scope; no claim that a locally observed count covers all client content.

## Primary-source checks

YouTube exposes title, description, thumbnails and duration as separate resource fields; its title maximum is 100 characters. This informs a future channel contract, not current Spool API access: [YouTube video resource](https://developers.google.com/youtube/v3/docs/videos).

LinkedIn supports media-specific post contracts, including multi-image and document examples. Review the current version before implementation; a Spool draft type does not confer posting permissions: [LinkedIn Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-09).

Private Vimeo oEmbed responses can omit identifying metadata. Every video must remain usable with a manual label and sharing link: [Vimeo private oEmbed](https://help.vimeo.com/hc/en-us/articles/12427906892689-Use-oEmbed-with-private-videos).

The report's LinkedIn reach-penalty claim was not independently established. Do not turn it into a factual blocking warning. Likewise avoid an absolute, timeless Instagram link rule: provide optional destination guidance, not an unverified guarantee.

## Release, recovery and acceptance

First release is SPA source only. No storage migration, client data operation, rule activation, provider credentials, Worker behavior/configuration, billing, email, parked project or held #110 deployment. Existing main deployment publishes the SPA alongside unchanged Worker source; compare its exact upload/config after any approved release.

Required: focused regressions and full application tests/lint/build/audits, independent source review, native IndexedDB and browser checks in Chromium/WebKit, protected GitHub checks, and new owner approval if a Spool admin merge override is needed. Prior one-time Spool approvals do not carry over.

After release, verify exact reviewed source, Worker/configuration and public assets. Owner/client should reopen an undated draft, add a tag and save, then create a new draft with no date, and check the originally reported access/older-thread experience without clearing device recovery. Do not use real drafts as destructive tests or automatically repair the mistakenly assigned date without confirming the intended plan.

A source rollback is acceptable only if it preserves all newly written null-date/recovery identities; never deploy a null-unaware recovery implementation as an incidental rollback. Prefer a forward fix or hold. Full feedback and QA evidence remain in the suite's dated private archive; this document records decisions without uploading client content.
<!-- The first-release status is verified. Record later release acceptance separately from preparation. -->
