---
name: draft-to-spool
description: Create or import social, blog, or job drafts in Spool's operator-only private staging. Use when the user asks to draft, push, send, or import content into Spool; send to client review only when explicitly requested.
---

# Draft to Spool

Create drafts in the user's **Spool** app via its intake API. They land in
operator-only `reviewStage:"private"` staging by default. Use `in_review` only when
the user explicitly asks to send them immediately for client review. You do the
gathering and writing; Spool receives the draft.

## Auth (required)
The Spool internal API key must be in the `SPOOL_API_KEY` environment variable.
- If it's set, use it.
- If it's not set, ask the user for it and have them `export SPOOL_API_KEY=…`.
- Never hardcode, log, or echo the key. It's server-side only — never put it in browser code.

## Endpoint
`POST https://spool.stitchtec.dev/api/drafts`
Headers: `Authorization: Bearer $SPOOL_API_KEY`, `Content-Type: application/json`

## Payload
| field | required | notes |
|---|---|---|
| `client` | yes | client / workspace name (existing or new) |
| `clientId` | – | canonical immutable client slug when known; prefer it over deriving identity from the display name |
| `platform` | yes | `gmb` · `facebook` · `linkedin` · `twitter` · `instagram` · `blog` · `job` |
| `content` | yes | post body; **Markdown** for `blog` / `job` |
| `title` | – | long-form only (`blog` / `job`) |
| `metaDescription` | – | SEO meta, long-form only |
| `altText` | – | image alt text (accessibility / SEO) |
| `tags` | – | array of strings, max 10 |
| `scheduledDate` | – | ISO 8601 string |
| `image` | – | one of `{"prompt":"…"}` (generate) · `{"url":"…"}` (reference) · `{"base64":"data:image/png;base64,…"}` (upload) |
| `reviewStage` | – | omit for safe `private` staging; use `in_review` only when the user explicitly asks to send immediately |

Returns `201 → {"id","status":"draft"}`. Draft creation does not mint or
return a review URL. It lands in operator-only `reviewStage:"private"` staging;
the operator deliberately sends it for review and manages tokenized links in Spool.

## How to run it
1. **Find the source.** It may be the user's text, a local file, a Google Drive doc, a
   web page, or content you generate. Use your own tools (Drive, web, file read) to
   gather it — Spool fetches nothing itself.
2. **Decide** the `client`, the target `platform(s)`, and whether an image is needed.
3. **Tailor to the platform**: X ≤ 280 chars and punchy; LinkedIn professional, a few
   short paragraphs; `blog`/`job` = Markdown with an H1 title + `##` sections. For
   several platforms from one source, write a platform-native version for each — don't
   just truncate.
4. **POST one request per draft:**
   ```bash
   curl -sS -X POST https://spool.stitchtec.dev/api/drafts \
     -H "Authorization: Bearer $SPOOL_API_KEY" -H "Content-Type: application/json" \
     -d '{"client":"Acme","platform":"linkedin","content":"…","tags":["nde"]}'
   ```
5. **Report** each created draft ID and that it is safely staged. Do not invent or
   derive a review URL.

## Manage existing drafts (not just create)
- `GET /api/drafts` (filters `?clientId=` `?client=` `?platform=` `?status=`
  `?reviewStage=`) — newest-first snapshot list (`updatedAt`, then id), capped at
  1 MiB for the complete JSON envelope. If `truncated:true`, repeat with the
  opaque `nextCursor` and identical filters; never scan an assumed whole list.
  `private` is operator staging; client-facing requests use exact
  `reviewStage=in_review`.
- `GET /api/drafts/{id}` — fetch one, including `clientId`, `payloadRevision`,
  and `reviewRevision`. List/get normalize `platform`, `title`, `content`,
  `imageUrl`, `altText`, `metaDescription`, and effective publication `slug` to
  explicit strings; do not invent defaults downstream.
- `PATCH /api/drafts/{id}` — change `content`/`title`/`platform`/
  `metaDescription`/`altText`/`slug`/`tags`/`scheduledDate`/`status`, or set an image
  (`image:{prompt|url|base64}` or `imageUrl`). Only the fields you send change.
- `DELETE /api/drafts/{id}` — delete.
- `GET /api/media` — list reusable images; reuse one via `PATCH imageUrl` instead of regenerating (saves cost).

Before every PATCH, GET the draft and echo its exact `clientId` and
`payloadRevision` as `baseClientId` and `basePayloadRevision`. Keep editorial
changes separate from review actions: save platform/title/content/image/
altText/metaDescription/slug/etc.,
then refetch the new revisions before a second PATCH that sends, holds, approves,
requests changes, or resubmits. Review-action PATCHes also echo
`baseReviewRevision`. This binds the action to the tenant, payload, and review
state that was actually seen. Tags do not change approval identity. A schedule
change does not revoke approval, but it changes `reviewRevision`, so a racing
review action must stop and refetch. Archived drafts are non-actionable. A
request-changes note must contain non-whitespace text and be at most 500
characters; send the exact accepted string because Spool does not trim or
truncate review feedback.

So *"find the right image and put it on the Acme blog draft"* = list to find the
ID → `GET /api/drafts/{id}` → `PATCH /api/drafts/{id}` with the image plus that
GET's `baseClientId`/`basePayloadRevision`.

## Errors
- `401` — missing/blank key. `403` — wrong key type (must be the internal key).
- `400` — missing `client`/`content` or unknown `platform`.
- `409` + `error:"review_conflict"` — the tenant, full approved preview, or
  review state changed. Refetch. Re-evaluate review intent against the new draft rather than
  blindly replaying an approval/send; retry an editorial request only against
  the refreshed revisions.
- `428` + `error:"review_baseline_required"` — required revision baselines are missing. GET the draft and rebuild the
  PATCH with its latest revision fields.
- Draft/review failures use `{error:<symbolic_code>,message}`. Treat
  `mixed_review_edit`, `feedback_invalid`, `feedback_thread_full`,
  `feedback_thread_invalid`, and `draft_cursor_invalid` as stable codes; show
  `message` to a person.
- `429` — rate limited; slow down and retry.
- `403` + "error 1010" — Cloudflare blocked the User-Agent. curl is fine; with raw HTTP libraries set a normal `User-Agent` (e.g. `spool-client/1.0`).

## Voice
Keep copy professional, specific, and credible; avoid hype and overclaiming.
