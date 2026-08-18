# Spool Drafts API — push content in from anywhere

Create review-ready drafts in Spool from any tool (Claude Code/Cowork, scripts,
Zapier). Drop this file in a Claude project and say e.g. *"draft these into Spool."*

> **⚠️ Changed 2026-08-18 — drafts now land in STAGING, not on the client's review
> link.** A draft created here arrives as `draft / pending / reviewStage:"private"`:
> it is in your dashboard (and in POM's Content card) immediately, but the client
> cannot see it until you press **Send for review** — or until a caller asks for it
> explicitly with `"reviewStage": "in_review"`. Previously every API-created draft
> was visible to the client on their live review link the instant it was written.
> Pre-existing drafts are unaffected: a missing `reviewStage` still means *in review*.

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
| `reviewStage` | – | `private` (default — lands in staging) or `in_review` (goes straight onto the client's review link) |

**Returns** `201` → `{ "id": "...", "status": "draft", "reviewUrl": "https://spool.stitchtec.dev/?uid=...&client=..." }`

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
| `GET /api/drafts` | List drafts. Filters: `?clientId=` (canonical slug — preferred; when present the name filter is ignored) `?client=` (display name, legacy) `?platform=` `?status=` `?reviewStage=` (`private` = still on your desk, `in_review` = with the client). `?limit=` caps the page (default **300**, max 1000). Returns `{drafts:[…],count,total,truncated}` — check `truncated` before treating a page as the whole set. |
| `GET /api/drafts/{id}` | Fetch one draft. |
| `PATCH /api/drafts/{id}` | Update any of `content`, `title`, `metaDescription`, `altText`, `tags`, `scheduledDate`, `status` (`draft`/`scheduled`/`posted`/`archived`), `reviewStage` (`private`/`in_review`), and `image` (`{prompt\|url\|base64}`) or `imageUrl`. Only the fields you send change. Setting `reviewStage:"in_review"` **is** the send: it stamps `sentForReviewAt` and re-arms an undecided draft to `pending` (an already-approved draft keeps its approval). |
| `DELETE /api/drafts/{id}` | Delete a draft. |
| `GET /api/media` | List reusable stored images (`{media:[{key,url,size,uploaded}],count}`) — pick one and set it via `PATCH imageUrl` instead of regenerating. |

```bash
# List blog drafts for a client
curl -sS "https://spool.stitchtec.dev/api/drafts?client=Acme&platform=blog" \
  -H "Authorization: Bearer $SPOOL_API_KEY"

# What's still on my desk (staged, not yet shown to the client)?
curl -sS "https://spool.stitchtec.dev/api/drafts?clientId=acme&reviewStage=private" \
  -H "Authorization: Bearer $SPOOL_API_KEY"

# Send a staged draft to the client's review link
curl -sS -X PATCH https://spool.stitchtec.dev/api/drafts/<id> \
  -H "Authorization: Bearer $SPOOL_API_KEY" -H "Content-Type: application/json" \
  -d '{"reviewStage":"in_review"}'

# Attach an existing/known image to a draft
curl -sS -X PATCH https://spool.stitchtec.dev/api/drafts/<id> \
  -H "Authorization: Bearer $SPOOL_API_KEY" -H "Content-Type: application/json" \
  -d '{"image":{"url":"https://…/hero.png"}}'
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
