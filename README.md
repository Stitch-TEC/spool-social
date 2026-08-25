# 🧵 Spool
> **Content approval workflows, simplified.**

[![Live Demo](https://img.shields.io/badge/🚀_Launch-Live_Demo-indigo?style=for-the-badge)](https://spool.stitchtec.dev/)
![React](https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white)
![Firebase](https://img.shields.io/badge/firebase-ffca28?style=for-the-badge&logo=firebase&logoColor=black)

**Spool** is a lightweight, agency-focused tool designed to streamline the process of drafting social media content and getting client approval. It replaces messy spreadsheets with a clean, visual dashboard and generates secure, read-only links for clients to review work.

---

## ✨ Key Features

* **🎨 Multi-Channel Drafting:** Create and preview posts for LinkedIn, X (Twitter), Instagram, and Google Business Profile.
* **📝 Long-form content:** **Blog** and **Job Posting** channels with a Markdown editor, formatting toolbar, and live preview.
* **🤖 AI throughout:** tone/length-aware drafting (Generate / Improve / Hashtags), per-client brand voice, **repurpose blog → social**, SEO meta descriptions, and brand-aware image generation with **vision alt-text**.
* **💡 Ideas panel:** content ideas pulled from the client's own website pages and GitHub releases/commits (brokered through the suite's feedback-worker) — one click seeds the AI prompt with "Write about: …".
* **🖼️ Media library:** a per-client asset panel — upload (auto-optimized) images, add video URLs (YouTube / Vimeo / file), reuse or delete — backed by R2.
* **🔌 Content API + Claude skill:** push and manage drafts from any tool (see [SPOOL_DRAFTS_API.md](SPOOL_DRAFTS_API.md) and the `/draft-to-spool` skill).
* **🔗 Client Approval Links:** Generate unique, shareable URLs for clients to review content without needing an account.
* **📅 Calendar & Grid Views:** Visualize content schedules at a glance.
* **🔒 Secure Architecture:** Permissions are enforced on the server (database rules), not just hidden in the app — so each client's content is walled off even if someone pokes at it directly. Plus key-/login-gated APIs, per-user rate limiting, and anonymous-token rejection.

> New here? See the [feature walkthrough](WALKTHROUGH.md).

---

## 👥 Who can use Spool

| Who | What they can do | Status |
|---|---|---|
| **Owner (you)** | See and manage everything — all clients, all content, all settings. | ✅ Live |
| **Reviewers** | Open a private link (no account needed) to review a single client's content — approve or request changes. They can't see other clients or edit anything. | ✅ Live |
| **Client teammates** | Their own secure login that shows **only their company's** content, which they can create, edit, and delete (and generate their own review links). Several people from the same company share the same content. | 🚧 Built — enable after deploy |

Access is checked in the database itself, so a client can only ever reach their own company's content — the rule holds no matter how the app is accessed.

---

## 🗺️ Roadmap

**✅ Live now**
* Owner dashboard: multi-channel drafting, AI assist, media library, calendar & grid views.
* No-account review links for clients (approve / request changes).
* Content API + Claude skill for pushing drafts in from other tools.

**🚧 Built, pending deploy — client accounts**
* Server-side permission rules walling each client company off to its own content (immutable per-client ID as the tenant key), one-time setup tooling, the role-aware app (sign-in resolves owner / client teammate / reviewer; teammates see and edit only their client and generate their own review links), review links bound to the per-client key, and an owner **Manage Users** screen. Turn on after deploy + re-issuing links — see [`RBAC_DEPLOY_RUNBOOK.md`](RBAC_DEPLOY_RUNBOOK.md).
* **Still to do:** per-client **media library** for teammates (the image library is owner-only for now); optional `clients/{clientId}` doc-id cleanup.

**🔮 Future ideas**
* **Client admins** who can invite and manage their own teammates (without the owner doing it).
* Tighter links across the wider Stitch suite (shared client identity across tools).
* Activity/audit history on who changed what.

---

## 🛠️ Tech Stack

* **Frontend:** React (Vite), Tailwind CSS, react-markdown
* **Backend:** Firebase (Firestore, Auth)
* **AI:** Shared Stitch AI gateway (`ai-worker`) for text + image, with direct Google Gemini as the multimodal path and resident fallback (see [AI via the shared gateway](#-ai-via-the-shared-gateway))
* **Edge/API/Storage:** Cloudflare Workers + R2 (app, generation + drafts API, image pool)
* **Icons:** Lucide React
* **Deployment:** Cloudflare Workers — auto-deploys on push to `main`

---

## 🤖 AI via the shared gateway

Both text (`generateText`) and image (`generateImage`) in [`worker/gemini.js`](worker/gemini.js) now route through the **shared Stitch AI gateway** (`ai-worker`) instead of calling Google directly. The gateway holds the provider keys; Spool only holds its own per-app key.

**How it's wired**

* **Service Binding:** the worker reaches the gateway over a Cloudflare Service Binding named **`AI`** (worker-to-worker RPC — no public network hop). It authenticates with the **`STITCH_AI_KEY`** secret, registered under appId **`spool`**.
* **Text** → gateway `POST /generate`. Tier comes from the **`SPOOL_AI_TIER`** env var (default **`cheap`**; bump to **`standard`** for richer copy).
* **Image** → gateway `POST /image` (the gateway's separate image axis).

**Fallback (resident direct-Gemini path)**

Spool keeps its direct Google Gemini path as a fallback. It is used automatically when:

* the prompt is **multimodal** (`opts.image` is set — e.g. vision alt-text from an actual image), which still goes direct to Gemini; **or**
* **any gateway call fails** (binding/key missing, error, or timeout) — the call falls through to direct Gemini so AI generation keeps working during cutover.

The direct path uses `GEMINI_API_KEY` plus the existing `GEMINI_TEXT_MODEL` / `GEMINI_IMAGE_MODEL` settings.

**Instant revert (no redeploy)**

```bash
# Stop routing through the gateway — Spool falls straight back to direct Gemini
wrangler secret delete STITCH_AI_KEY
```

With `STITCH_AI_KEY` absent, `generateText` / `generateImage` skip the gateway entirely and use direct Gemini. Re-add the secret to switch back.

**Rotating or revoking Spool's gateway key**

Per-app keys are managed from the **`ai-worker`** repo, not here:

```bash
# In the ai-worker repo:
node scripts/register-key.mjs add spool --remote      # mint a new key (printed once) — then re-set STITCH_AI_KEY here
node scripts/register-key.mjs revoke spool --remote   # disable Spool's key centrally (effective within ~60s)
node scripts/register-key.mjs list --remote           # list registered apps
```

After minting a new key, set it on Spool with `wrangler secret put STITCH_AI_KEY`.

---

## 🧷 Client context, brand & ideas from POM (the suite seam)

The Worker also pulls per-client knowledge from the suite broker (**feedback-worker**,
`feedback.stitchtec.dev`), authenticated with the **`CONTEXT_KEY`** secret — always
**server-side**; the key never reaches the browser.

* **Generation injection** (`POST /api/text` + `POST /api/generate`, and the automation cron):
  `GET /client-profile` supplies the client's AI context, the one-line brand summary, the
  **structured brand kit** (palette hexes + names, free-text theme, logo URL), the
  **auto-refreshed recent-activity digest** (`recentActivity` — POM's `autoContext`, written by
  the broker's weekly crawl of the client's site/repos), and the asset-library manifest. Text
  prompts gain a `Brand style: <theme>` directive plus the context/recent-activity/assets lines;
  image prompts render the exact palette hexes + theme (falling back to the lossy one-line brand
  string on old brokers). All fetched site/repo text is framed as **untrusted reference data,
  never instructions** (see `renderPom*` in [`src/generation/prompts.js`](src/generation/prompts.js)).
* **`GET /api/ideas?client=<name-or-slug>`** (authed like generation; client members pinned to
  their own slug): brokered read of feedback-worker `GET /client-signals` — the client's site
  pages + repo releases/commits — returning `{ ok, slug, signals: { fetchedAt, cached, site,
  repos } }`. Backs the editor's **Ideas panel**, whose "Draft from this" seeds the AI prompt.
* **Fail-open / kill switch:** with `CONTEXT_KEY` absent, generation simply skips the injection
  and `/api/ideas` answers `{ ok:false, error:'not_configured' }` — the Ideas panel quietly
  disappears. A real upstream failure is a 502 (the panel hides on that too).
* **Diagnostics:** `GET /api/seam-status` (public, presence only) and `GET /api/context-check`
  (operator) — the latter now reports the brand theme, logo-URL presence, palette color count,
  and the recent-activity refresh timestamp so the whole seam is observable from Spool's side.

---

## 🚀 Getting Started

### Prerequisites
* Node.js (v18+)
* A Firebase Project

### Installation

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/Stitch-TEC/spool-social.git
    cd spool-social
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Configure Environment Variables:**
    Create a `.env` file in the root directory. Do **not** commit this file.
    ```env
    VITE_FIREBASE_API_KEY=your_api_key
    VITE_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
    VITE_FIREBASE_PROJECT_ID=your_project_id
    VITE_FIREBASE_STORAGE_BUCKET=your_project.firebasestorage.app
    VITE_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
    VITE_FIREBASE_APP_ID=your_app_id
    # Production is pinned by deploy.yml; aliases are accepted only as legacy
    # media inputs and all generated URLs use VITE_PUBLIC_ORIGIN.
    VITE_PUBLIC_ORIGIN=https://spool.stitchtec.dev
    VITE_LEGACY_MEDIA_ORIGINS=https://spool.kist.workers.dev
    ```

4.  **Run Locally:**
    ```bash
    npm run dev
    ```

---

## 📦 Deployment

Every push to `main` is automatically built and deployed to **Cloudflare Workers** via GitHub Actions (`.github/workflows/deploy.yml`), authenticated with the `CLOUDFLARE_API_TOKEN` repo secret. The Firebase web config is injected from repository **Actions variables**.

Media hardening has an additional operational checklist: R2 inventory/signature
audit, legacy Cloudflare cache purge, browser-cache residual, and the manual
Firestore rules deploy. Follow [`MEDIA_SECURITY_ROLLOUT.md`](MEDIA_SECURITY_ROLLOUT.md);
merging origin code alone does not complete that rollout.

The private review-stage/newest-first boundary has mandatory guarded legacy-data
and index steps before merge. The actual release is a frozen maintenance window:
feedback-worker → POM → Spool → immediate manual rules → contract/security checks
→ R2/cache verification, with no approval actions during it. Follow
[`REVIEW_STAGE_ROLLOUT.md`](REVIEW_STAGE_ROLLOUT.md); do not deploy strict rules
against missing stage/order values or an old SPA query.

### Manual Deploy (fallback)
To build and deploy from your local machine:

```bash
npm run deploy
```

---

## 🔑 Granting access (owner / admin)

Access is managed with a small command-line tool, [`scripts/admin.mjs`](scripts/admin.mjs) (needs a Firebase service-account key, kept outside the repo):

```bash
# 1. Make yourself the owner (one-time, before deploying the new rules)
node scripts/admin.mjs bootstrap --email you@example.com --key sa.json

# 2. Tag all existing content with which client it belongs to, then double-check
node scripts/admin.mjs backfill --key sa.json            # preview
node scripts/admin.mjs backfill --key sa.json --apply
node scripts/admin.mjs id-inventory --key sa.json         # must be compatible
node scripts/admin.mjs review-stage --key sa.json --roster /secure/path/clients.json         # preview
node scripts/admin.mjs review-stage --key sa.json --roster /secure/path/clients.json --apply # ordinary→in_review; suggestions→private
node scripts/admin.mjs audit --key sa.json --roster /secure/path/clients.json                 # should report "clean"
firebase deploy --only firestore:indexes --project spool-social                              # wait until READY

# 3. (Future) give a client teammate access — only once client logins are turned on
node scripts/admin.mjs grant --email person@client.com --role client --client-id their-id --key sa.json
```

Full step-by-step order and the safety checks are in [`RBAC_DEPLOY_RUNBOOK.md`](RBAC_DEPLOY_RUNBOOK.md).
> ⚠️ Client teammate logins aren't switched on yet — finish the client-accounts phase before granting `client` roles.
