# Spool Drafts API — push content in from anywhere

Create review-ready drafts in Spool from any tool (Claude Code/Cowork, scripts,
Zapier). Drafts land in your dashboard as **draft / pending** for your normal
review + client-approval flow. Drop this file in a Claude project and say e.g.
*"draft these into Spool."*

- **Base URL:** `https://spool.stitchtec.dev`
- **Auth:** `Authorization: Bearer <INTERNAL_API_KEY>` — **server-side only**, never in browser/client code.

## `POST /api/drafts`

| field | required | notes |
|---|---|---|
| `client` | ✅ | client/workspace name (existing or new) |
| `platform` | ✅ | `gmb` · `linkedin` · `twitter` · `instagram` · `blog` · `job` |
| `content` | ✅ | post body (Markdown for `blog`/`job`); capped to the platform's limit |
| `title` | – | long-form only (`blog`/`job`) |
| `altText` | – | image alt text |
| `metaDescription` | – | SEO meta description (`blog`/`job`) |
| `tags` | – | array of strings (max 10) |
| `scheduledDate` | – | ISO 8601 string |
| `image` | – | one of `{ "prompt": "..." }` (generate) · `{ "url": "..." }` (reference) · `{ "base64": "data:image/png;base64,..." }` (upload) |

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
