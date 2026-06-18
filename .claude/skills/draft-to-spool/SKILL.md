---
name: draft-to-spool
description: Push content into Spool as a review-ready draft — social posts (LinkedIn / X / Instagram / Google Business), blog posts, or job postings. Use when the user wants to draft, send, push, or import content into Spool, or turn a doc / Google Drive file / idea / web page into Spool drafts for client review.
---

# Draft to Spool

Create review-ready drafts in the user's **Spool** app via its intake API. Drafts land
in the Spool dashboard as **draft / pending** for the user's normal review + client
approval flow. You do the gathering and writing; Spool just receives the draft.

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
| `platform` | yes | `gmb` · `linkedin` · `twitter` · `instagram` · `blog` · `job` |
| `content` | yes | post body; **Markdown** for `blog` / `job` |
| `title` | – | long-form only (`blog` / `job`) |
| `metaDescription` | – | SEO meta, long-form only |
| `altText` | – | image alt text (accessibility / SEO) |
| `tags` | – | array of strings, max 10 |
| `scheduledDate` | – | ISO 8601 string |
| `image` | – | one of `{"prompt":"…"}` (generate) · `{"url":"…"}` (reference) · `{"base64":"data:image/png;base64,…"}` (upload) |

Returns `201 → {"id","status":"draft","reviewUrl"}`.

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
5. **Report** each draft's `reviewUrl` back to the user.

## Errors
- `401` — missing/blank key. `403` — wrong key type (must be the internal key).
- `400` — missing `client`/`content` or unknown `platform`.
- `429` — rate limited; slow down and retry.

## Voice
Keep copy professional, specific, and credible; avoid hype and overclaiming.
