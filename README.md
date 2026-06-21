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
* **AI:** Google Gemini (text + image, multimodal)
* **Edge/API/Storage:** Cloudflare Workers + R2 (app, generation + drafts API, image pool)
* **Icons:** Lucide React
* **Deployment:** Cloudflare Workers — auto-deploys on push to `main`

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
    ```

4.  **Run Locally:**
    ```bash
    npm run dev
    ```

---

## 📦 Deployment

Every push to `main` is automatically built and deployed to **Cloudflare Workers** via GitHub Actions (`.github/workflows/deploy.yml`), authenticated with the `CLOUDFLARE_API_TOKEN` repo secret. The Firebase web config is injected from repository **Actions variables**.

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
node scripts/admin.mjs audit   --key sa.json             # should report "clean"

# 3. (Future) give a client teammate access — only once client logins are turned on
node scripts/admin.mjs grant --email person@client.com --role client --client-id their-id --key sa.json
```

Full step-by-step order and the safety checks are in [`RBAC_DEPLOY_RUNBOOK.md`](RBAC_DEPLOY_RUNBOOK.md).
> ⚠️ Client teammate logins aren't switched on yet — finish the client-accounts phase before granting `client` roles.
