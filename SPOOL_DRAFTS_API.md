# Spool Drafts API — push content in from anywhere

Create review-ready drafts in Spool from any tool (Claude Code/Cowork, scripts,
Zapier). Drop this file in a Claude project and say e.g. *"draft these into Spool."*

> **⚠️ Changed 2026-08-18 — drafts now land in STAGING, not on the client's review
> link.** A draft created here arrives as `draft / pending / reviewStage:"private"`:
> it is in your dashboard (and in the **operator-only** POM Content card) immediately, but the client
> cannot see it until you press **Send for review** — or until a caller asks for it
> explicitly with `"reviewStage": "in_review"`. Previously every API-created draft
> was visible to the client on their live review link the instant it was written.
> Pre-existing drafts retain that historical meaning only after the guarded
> `review-stage` backfill. Once strict rules ship, a missing stage fails closed;
> follow `REVIEW_STAGE_ROLLOUT.md` before merging/deploying this change.

- **Base URL:** `https://spool.stitchtec.dev`
- **Auth:** `Authorization: Bearer <INTERNAL_API_KEY>` — **server-side only**, never in browser/client code.

## `POST /api/drafts`

| field | required | notes |
|---|---|---|
| `client` | ✅ | client/workspace name (existing or new) |
| `platform` | ✅ | `gmb` · `facebook` · `linkedin` · `twitter` · `instagram` · `blog` · `job` |
| `content` | ✅ | post body (Markdown for `blog`/`job`); capped to the platform's limit |
| `title` | – | long-form only (`blog`/`job`) |
| `altText` | – | image alt text |
| `metaDescription` | – | SEO meta description (`blog`/`job`) |
| `tags` | – | array of strings (max 10) |
| `scheduledDate` | – | ISO 8601 string |
| `image` | – | one of `{ "prompt": "..." }` (generate) · `{ "url": "..." }` (reference) · `{ "base64": "data:image/png;base64,..." }` (upload) |
| `reviewStage` | – | `private` (default — operator staging only) or `in_review` (goes straight onto the client's review link). Client-facing POM/API consumers must request exact `in_review`; only the operator POM surface may request/show `private`. |

**Returns** `201` → `{ "id": "...", "status": "draft" }`. Draft creation does
not create or return a review URL. Review access is deliberate: the operator
uses Share Manager (the tokenized `/api/share` flow) when the content is ready.

### Examples

```bash
# Text draft (LinkedIn)
curl -X POST https://spool.stitchtec.dev/api/drafts \
  -H "Authorization: Bearer $SPOOL_API_KEY" -H "Content-Type: application/json" \
  -d '{"client":"Acme","platform":"linkedin","content":"...","tags":["nde","aerospace"]}'

# Blog draft with an AI-generated hero image
curl -X POST https://spool.stitchtec.dev/api/drafts \
  -H "Authorization: Bearer $SPOOL_API_KEY" -H "Content-Type: application/json" \
  -d '{"client":"Acme","platform":"blog","title":"...","content":"# ...\n\n## ...","metaDescription":"...","image":{"prompt":"a clean studio photo of a carbon-fiber panel"}}'
```

## Using it from Claude (Cowork / Code)

> *"Pull the Q3 case study from my Google Drive, write a LinkedIn post and a blog version for client Acme, and push them into Spool as drafts."*

Claude reads Drive (or the web, or local files) with **its own** tools, drafts the
content, then `POST`s each one here. **Spool itself needs no Google Drive access** —
it's just the intake endpoint; the calling Claude does the gathering.

Image bytes pulled from Drive can be sent as `image.base64`; or pass `image.prompt`
to have Spool generate one, or `image.url` to reference a hosted image.

## Manage existing drafts (full CRUD)

| Method & path | Purpose |
|---|---|
| `GET /api/drafts` | Newest-first snapshot list (`updatedAt DESC`, then document id DESC). Filters: `?clientId=` (canonical slug — preferred; when present the name filter is ignored) `?client=` (display name, legacy) `?platform=` `?status=` `?reviewStage=`. `private` is operator-only staging; every client-facing POM/API request must use exact `reviewStage=in_review`. `?limit=` caps rows (default **300**, max 1000); the complete serialized response—including transformed rows, revisions, envelope, and cursor—is capped at **1 MiB** and may end earlier. Returns `{drafts,count,total,truncated,nextCursor}`: `total` is the exact matching count across the immutable snapshot, `count` is this page, and `truncated:true` means pass the opaque `nextCursor` with the **same filters** to continue. Every row includes guarded-PATCH revisions. |
| `GET /api/drafts/{id}` | Fetch one draft, including its `payloadRevision` and `reviewRevision`. |
| `PATCH /api/drafts/{id}` | Update any of `content`, `title`, `platform`, `metaDescription`, `altText`, `slug`, `tags`, `scheduledDate`, `status` (`draft`/`scheduled`/`posted`/`archived`), `reviewStage` (`private`/`in_review`), and `image` (`{prompt\|url\|base64}`) or `imageUrl`. Every PATCH must echo the latest `baseClientId` + `basePayloadRevision`; review actions (`reviewStage` or `approvalStatus`) must also echo `baseReviewRevision`. Only the fields you send change. Setting `reviewStage:"in_review"` **is** the send: it stamps `sentForReviewAt` and re-arms an undecided draft to `pending` (an already-approved draft keeps its approval). |
| `DELETE /api/drafts/{id}` | Delete a draft. |
| `GET /api/media` | List reusable stored images (`{media:[{key,url,size,uploaded}],count}`) — pick one and set it via `PATCH imageUrl` instead of regenerating. |

Draft IDs are Firestore SDK auto-IDs (exactly 20 ASCII alphanumeric
characters); malformed, encoded-slash, and traversal-shaped IDs return `400`
before any datastore access. Before the strict Worker rollout, run the
`scripts/admin.mjs id-inventory` stop gate documented in
`REVIEW_STAGE_ROLLOUT.md` so a legacy custom post/automation/share ID is not
stranded. PATCH is deliberately not blind: obtain the row with GET/list, then
echo its `clientId` as `baseClientId` and its opaque `payloadRevision`. A missing
baseline returns `428`; tenant/content drift returns `409`. A review action also
echoes `reviewRevision`, so a racing approve/note/send/hold returns `409` instead
of silently last-writing the other action. The Worker additionally uses live
Firestore `updateTime` compare-and-swap and retries ordinary edits against current
review state. Approval identity is the complete preview: platform, title,
content, canonical image identity, alt text, SEO description, and effective
publication slug. List/get always return those fields as explicit strings. For
a legacy long-form row with no stored slug, Spool derives the exact path from
the same bound title/content fallback the publisher uses; downstream callers
must not invent one. Changing any of those fields resets an approval. Missing
and explicit-empty optional values are digest-equivalent.
Review actions are deliberately isolated from editorial changes: do not combine
`approvalStatus` or `reviewStage` with content, title, platform, image, alt text,
SEO description, slug, tags, or scheduling
edits in one request. Save the editorial change, refetch the returned revisions,
then perform the review action against that exact payload. Tags are internal and
do not affect either revision. Scheduling is workflow-only: it does not revoke
approval, but it changes `reviewRevision`, so a racing review action returns
`409`. Archived drafts cannot be approved or sent back for changes. Accepted
feedback is non-whitespace, at most 500 characters, and stored exactly (never
silently trimmed or truncated).
Spool v1 and relative-v2 media references in `imageUrl` and rendered
Markdown/HTML image targets are returned and accepted as absolute, current-origin
`https://spool.stitchtec.dev/media/v2/…` URLs; third-party URLs and prose are not
rewritten. Uploaded raster bytes are capped at 5 MB.

Error responses for review/pagination conflicts are stable
`{"error":"<symbolic_code>","message":"<safe human message>"}` envelopes.
Callers should branch on `review_baseline_required`, `review_conflict`,
`mixed_review_edit`, `feedback_invalid`, `feedback_thread_full`,
`feedback_thread_invalid`, and `draft_cursor_invalid`, and display `message`. A single serialized row too large
for the page fails closed as `413 draft_row_too_large`; it is not silently
skipped. Repair or quarantine that row before continuing.

```bash
# List blog drafts for a client
curl -sS "https://spool.stitchtec.dev/api/drafts?client=Acme&platform=blog" \
  -H "Authorization: Bearer $SPOOL_API_KEY"

# If truncated is true, continue with the opaque cursor and identical filters
curl -sS "https://spool.stitchtec.dev/api/drafts?client=Acme&platform=blog&cursor=<nextCursor>" \
  -H "Authorization: Bearer $SPOOL_API_KEY"

# What's still on my desk (staged, not yet shown to the client)?
curl -sS "https://spool.stitchtec.dev/api/drafts?clientId=acme&reviewStage=private" \
  -H "Authorization: Bearer $SPOOL_API_KEY"

# Fetch first; keep these exact values with the action the user saw
curl -sS https://spool.stitchtec.dev/api/drafts/<id> \
  -H "Authorization: Bearer $SPOOL_API_KEY"

# Send a staged draft to the client's review link
curl -sS -X PATCH https://spool.stitchtec.dev/api/drafts/<id> \
  -H "Authorization: Bearer $SPOOL_API_KEY" -H "Content-Type: application/json" \
  -d '{"baseClientId":"acme","basePayloadRevision":"<64-hex from GET>","baseReviewRevision":"<64-hex from GET>","reviewStage":"in_review"}'

# Attach an existing/known image to a draft
curl -sS -X PATCH https://spool.stitchtec.dev/api/drafts/<id> \
  -H "Authorization: Bearer $SPOOL_API_KEY" -H "Content-Type: application/json" \
  -d '{"baseClientId":"acme","basePayloadRevision":"<64-hex from GET>","image":{"url":"https://…/hero.png"}}'
```

### Media library (`/api/media`)

- `GET /api/media` — the generated AI-image pool (in-editor reuse).
- `GET /api/media?client=X` — a client's curated library (images + video references).
- `POST /api/media` — `{ "client": "...", "image": { "base64": "data:..." } }` to upload an (optimized) image, or `{ "client": "...", "videoUrl": "..." }` for a YouTube / Vimeo / direct-file reference. **Max 50 items per client.**
- `DELETE /api/media/{key}` — remove one item.

Accepts the internal key (whole workspace) or a **Firebase user token** (the caller's own images; the configured owner also sees the shared `generated/internal/` pool).

## ⚠️ User-Agent
Cloudflare bot protection on this zone returns **403 / "error 1010"** for default library
User-Agents (e.g. `python-urllib`). **curl is fine.** With raw HTTP libraries, set a normal
UA, e.g. `User-Agent: spool-client/1.0`.

*(Orphaned images from deleted drafts are swept automatically each night after a 7-day grace window — no manual cleanup needed.)*
