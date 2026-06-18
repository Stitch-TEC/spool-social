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
* **🖼️ Media library:** reuse previously AI-generated images from an R2-backed pool instead of regenerating.
* **🔌 Content API + Claude skill:** push and manage drafts from any tool (see [SPOOL_DRAFTS_API.md](SPOOL_DRAFTS_API.md) and the `/draft-to-spool` skill).
* **🔗 Client Approval Links:** Generate unique, shareable URLs for clients to review content without needing an account.
* **📅 Calendar & Grid Views:** Visualize content schedules at a glance.
* **🔒 Secure Architecture:** Key-/login-gated APIs, per-user rate limiting, and anonymous-token rejection.

> New here? See the [feature walkthrough](WALKTHROUGH.md).

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
