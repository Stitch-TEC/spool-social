# 🧵 Spool — What's New & How to Use It

A guided tour of everything added recently. Spool is now a **content drafting & review
hub** — social posts, blogs, and job postings — with AI throughout, hosted on Cloudflare
at **https://spool.stitchtec.dev**.

> Sign in with Google. Clients still review via read-only share links (no account needed).

---

## 1. AI drafting for any post
**Where:** open/create a post → **AI draft**.

- **Tone** (Professional / Friendly / Bold / Educational) and **Length** (Short / Medium / Long).
- **Generate** — write a fresh draft from a one-line topic.
- **Improve** — rewrite your *current* draft (optionally with guidance like "make it punchier"). Switch the platform first and hit Improve to re-tailor it for that channel.
- **Hashtags** — append relevant hashtags to the draft.

Every draft is **platform-aware**: X stays under 280 characters, LinkedIn gets short paragraphs, Google Business avoids hashtags, etc.

**How to use:** click **AI draft**, type a topic, pick tone + length, hit **Generate**. Then tweak with **Improve**.

---

## 2. Per-client AI memory
**Where:** Sidebar → **Client Settings** → *AI Content Defaults*.

Set a client's **Brand Voice**, **Target Audience**, **Default Tone**, **Keywords to include**, and **Words/topics to avoid**. From then on, every AI draft for that client is automatically written in their voice — pick the client and the tone even pre-fills.

**How to use:** Client Settings → choose a client → fill the AI fields → Save. Then draft as normal.

---

## 3. AI images
**Where:** a post's **Visual Asset** → **Generate image**.

- **Style presets** (Photo / Studio product / Illustration / Minimal / Bold graphic).
- **Brand- & platform-aware** — uses the client's brand color/themes and the right aspect ratio per channel.
- **Alt text** — once an image is set, click **Generate** next to *Alt text* and the AI describes the actual image (accessibility + SEO). Editable.

**How to use:** Generate image → describe it → pick a style → **Generate**. Then generate alt text.

---

## 4. Blog & long-form (Blog + Job Posting)
**Where:** pick the **Blog** or **Job Posting** channel in the editor.

- **Markdown editor** with a **formatting toolbar** (Heading / Bold / Italic / List / Quote / Link / Code) and a **live rendered preview** (now shows your image too).
- **Title** field + no character-limit pressure.
- **Long-form AI** — "AI draft → Generate" writes a full, structured article/posting (headings, sections) in Markdown.
- **SEO** — generate a **meta description**; a URL **slug** is auto-derived from the title.
- **Mobile**: tap **Preview** in the header to see the rendered result.

**How to use:** choose **Blog** → add a title → **AI draft → Generate** (set Length = Long) → polish with the toolbar → generate a meta description.

---

## 5. Repurpose blog → social
**Where:** in a Blog/long-form post → **Repurpose → social**.

Turn one long-form piece into channel-tailored drafts. Pick LinkedIn / X / Instagram / Google Business and it creates a native draft for each (not a truncation) under the same client.

**How to use:** write the blog → **Repurpose → social** → select channels → **Create drafts**. They appear in your grid for review.

---

## 6. Push drafts in from anywhere (Drafts API + `/draft-to-spool`)
**What:** any tool — Claude Code/Cowork, a script, Zapier — can create Spool drafts via an API. Great for "pull this from Google Drive and draft it into Spool."

- **API:** `POST https://spool.stitchtec.dev/api/drafts` with `Authorization: Bearer <key>`. Full contract in [SPOOL_DRAFTS_API.md](SPOOL_DRAFTS_API.md).
- **Claude skill:** the **`/draft-to-spool`** skill — drop into any Claude Code/Cowork project, set `SPOOL_API_KEY`, and say *"Pull the Q3 case study from my Drive and draft a LinkedIn post + a blog version for Acme into Spool."* Claude gathers the content and pushes the drafts; they show up for review.

**How to use:** `export SPOOL_API_KEY=…` in the project, then ask Claude to draft into Spool, or call the endpoint directly with `curl`.

---

## 7. Behind the scenes
- **Hosting:** moved to a single **Cloudflare Worker** serving the app + the generation/intake API; images stored in **R2**. Firebase still handles Auth + data.
- **Custom domain:** `spool.stitchtec.dev` (the `workers.dev` URL still works too).
- **Suite tool-switcher:** the grid icon (top-left) jumps between Stitch Suite apps (POM / Sender / Spool).
- **Auto-deploy:** every merge to `main` builds and deploys to Cloudflare automatically.
- **Security:** generation/intake APIs are key- or login-gated, rate-limited, and reject anonymous/guest tokens. Generated images are private by unguessable URL.

---

## Quick reference — what writes a draft?
| You're in… | Use |
|---|---|
| Spool, drafting yourself | **AI draft** (Generate / Improve / Hashtags) |
| Spool, a long-form piece | **Blog/Job** editor + toolbar, **Repurpose → social** |
| Another app / Claude / a script | **Drafts API** or **`/draft-to-spool`** |

Everything lands as a **draft** for your review before anything is shared with a client.
