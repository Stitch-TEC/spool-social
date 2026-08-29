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
- **Media library** — *"Choose from library"* opens a picker of your previously **AI-generated** images so you can **reuse** one instead of regenerating (saves cost). Orphaned images are swept automatically each night. *(Uploaded-from-disk images are stored on the post, not in this pool.)*
- **Alt text** — once an image is set, enter a concise manual description for accessibility + SEO. The **Generate** helper currently explains that automatic vision is unavailable until the shared AI gateway accepts image input; it leaves existing text untouched.

**How to use:** **Generate image** (describe it → pick a style → **Generate**), or **Choose from library** to reuse one. Add concise alt text manually; the automatic vision helper is temporarily unavailable until the shared AI gateway accepts image input.

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

## 7. Media Library (sidebar)
**Where:** Sidebar → **Media Library**.

A **per-client** asset library: **upload** images (auto-optimized to ~2048px — only the optimized version is stored), **add video URLs** (YouTube / Vimeo / direct `.mp4`/`.webm`/`.mov`), and **delete** anything manually. Each client holds up to **50 items**. Uploaded library images also show in the in-editor "Choose from library" picker.

**How to use:** Sidebar → **Media Library** → pick a client → **Upload image** / paste a **video URL** / hover an item to **delete**.

*(Auto-cleanup only ever touches the AI-generation cache, and only images unused for over a year — your library is manual-delete only.)*

## 8. Behind the scenes
- **Hosting:** moved to a single **Cloudflare Worker** serving the app + the generation/intake API; images stored in **R2**. Firebase still handles Auth + data.
- **Custom domain:** `spool.stitchtec.dev` (the `workers.dev` URL still works too).
- **Suite tool-switcher:** the grid icon (top-left) jumps between Stitch Suite apps (POM / Sender / Spool).
- **Auto-deploy:** every merge to `main` builds and deploys to Cloudflare automatically.
- **Security:** generation/intake APIs are key- or login-gated, rate-limited, and reject anonymous/guest tokens. Generated images are private by unguessable URL.

---

## 9. Client review & sharing (tokenized links)
**Where:** header → **Share**.

- **Create a review link per client** in the Share Manager — copy it, send it,
  **revoke** it anytime. Each link scopes a reviewer to exactly one client; they
  can’t see other clients or edit anything.
- **Reviewers** open the link (no account), see a **progress bar** ("5 of 8
  approved"), and **Approve** or **Request changes** right from each card.
- **Threaded feedback** — feedback is kept as a history across review rounds
  instead of overwriting a single note.

Full details + the deploy/migration steps are in [SHARE_LINKS.md](SHARE_LINKS.md).
> Security: a leaked workspace id no longer grants access — only a valid `?s=` token does.

---

## 10. Bulk editing & data
**Where:** grid → **Select**; Sidebar → **Import / Export**.

- **Mass edit** — turn on **Select**, pick threads, then from the bottom bar:
  reassign **client**, add/remove **tags**, set **status**, **archive**, **delete**,
  or **export** just the selection.
- **Rename / merge a client** — Client Settings → *Rename or merge*: moves every
  thread from one client name to another (fix a typo, or merge two into one).
- **Import** — CSV **or** JSON, with a **preview** (counts + breakdown) and a
  **skip-duplicates** option before anything is written.
- **Export** — lossless **CSV** (now includes title, tags, alt text, meta, slug)
  or a full-fidelity **JSON backup**.
- **Resizable preview** — drag the divider in the editor to widen the live
  preview (great for long-form blog/job posts); the width is remembered.

---

## Quick reference — what writes a draft?
| You're in… | Use |
|---|---|
| Spool, drafting yourself | **AI draft** (Generate / Improve / Hashtags) |
| Spool, a long-form piece | **Blog/Job** editor + toolbar, **Repurpose → social** |
| Another app / Claude / a script | **Drafts API** or **`/draft-to-spool`** |

Everything lands as a **draft** for your review before anything is shared with a client.
