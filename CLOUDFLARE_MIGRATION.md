# Spool → Cloudflare migration + generation API

> **STATUS UPDATE (2026-06-18):** This migration is **SHIPPED & merged to `main`**.
> Spool is live at **spool.stitchtec.dev** on a Cloudflare Worker + R2 (Firebase
> still handles auth/data). `stitchtec.dev` is the canonical domain for everything
> (the owner's `.com` forwards to `.dev`). The notes below describe the original
> migration work; treat the "branch" framing as historical. The Roadmap items at
> the bottom are still the open backlog.
>
> **AI BOUNDARY UPDATE (2026-08-29):** Spool source no longer reads or calls a Google
> provider key. Every text and image generation request goes through the shared
> `ai-worker` Service Binding with Spool's per-app `STITCH_AI_KEY`. The historical
> direct-Gemini setup is retired; gateway/provider failure disables only the
> optional AI action and never reroutes around suite metering or quotas.
> A legacy deployed provider secret may remain inert until separate post-release
> cleanup; source tests prevent it from restoring a direct path.

This branch (`feat/cloudflare-worker`) moves Spool off GitHub Pages and onto a
single **Cloudflare Worker** that serves the app *and* exposes an image/text
generation API backed by the shared Stitch **AI gateway**, with generated images
stored in **Cloudflare R2**.

Firebase (Auth + Firestore) is unchanged — the app still uses it directly from
the browser. Only hosting moved, plus the new API.

---

## Architecture

```
                        ┌──────────────────────────────────────┐
   Browser (Spool SPA)  │           Cloudflare Worker           │
   ───────────────────► │  GET  /              → static assets  │
     Firebase ID token  │  GET  /media/<key>   → R2 image       │
                        │  POST /api/generate  → AI /image → R2 │
   Your other projects  │  POST /api/text      → AI /generate   │
   ───────────────────► │  (auth: Firebase token OR API key)    │
     INTERNAL_API_KEY   └───────────────┬───────────────┬───────┘
                                        │               │
                                ai-worker binding    R2 bucket
                               (provider-neutral)   (spool-media)

   Firestore + Firebase Auth  ◄──── still used directly by the SPA
```

**Why this shape:** the in-app feature and reusable Spool API remain on the same
Worker, while model inference is centralized. Spool authenticates callers and
injects client context; `ai-worker` alone owns provider credentials, routing,
metering, quotas, and provider failover.

---

## What's in this branch

| File | Purpose |
|---|---|
| `wrangler.toml` | Worker config: static assets, R2 binding, vars |
| `worker/index.js` | Router: `/api/generate`, `/api/text`, `/media/*`, SPA fallback |
| `worker/auth.js` | Dual auth — Firebase ID-token verification + internal API key |
| `worker/aiGateway.js` | Gateway-only text + image calls; safe availability errors |
| `src/utils/generationApi.js` | Front-end client (sends the user's Firebase token) |
| `src/components/AIGenerate.jsx` | Inline "Generate image" / "AI draft" control |
| `src/components/Editor.jsx` | Wired the two controls into the editor |
| `vite.config.js` | `base: '/'` for Worker hosting + dev proxy to `wrangler dev` |
| `package.json` | `deploy` now targets Cloudflare; `deploy:pages` kept for legacy |

---

## One-time setup

Prereqs: a Cloudflare account and a Spool per-app key registered by `ai-worker`.

```bash
# 1. Install deps (adds wrangler)
npm install

# 2. Log in to Cloudflare
npx wrangler login

# 3. Create the R2 bucket for generated images
npx wrangler r2 bucket create spool-media

# 4. Set the Firebase project id in wrangler.toml
#    (FIREBASE_PROJECT_ID = "..."  — the same projectId your app uses)

# 5. Set secrets (never commit these)
npx wrangler secret put STITCH_AI_KEY       # per-app key registered as appId "spool"
npx wrangler secret put INTERNAL_API_KEY    # a long random string you invent
```

Generate a strong internal key with: `openssl rand -hex 32`

---

## Deploy

```bash
npm run deploy      # builds the SPA, then `wrangler deploy`
```

Wrangler prints a URL like `https://spool.<your-subdomain>.workers.dev`.
Add a custom domain later in the Cloudflare dashboard (e.g. `spool.stitchtec.dev`).

> **Firebase:** add the new Worker domain to Firebase Auth → Settings →
> Authorized domains, or Google sign-in will be blocked there.

---

## Local development

Two terminals:

```bash
npx wrangler dev     # Worker + API on http://localhost:8787
npm run dev          # Vite on http://localhost:5173 (proxies /api + /media to 8787)
```

---

## Test the API directly (no UI needed)

```bash
# Health check
curl https://spool.<your-subdomain>.workers.dev/api/health

# Text generation (internal key)
curl -X POST https://spool.<your-subdomain>.workers.dev/api/text \
  -H "Authorization: Bearer $INTERNAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Write a 1-line LinkedIn hook about contactless NDE inspection"}'

# Image generation -> returns { "url": "...", "key": "..." }
curl -X POST https://spool.<your-subdomain>.workers.dev/api/generate \
  -H "Authorization: Bearer $INTERNAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"A clean product photo of a carbon-fiber panel on a white studio background"}'
```

Your other projects use the same calls with the internal key. Spool's browser
uses the user's Firebase token automatically (no key in the front end).

---

## Cost boundary

- **Cloudflare Workers free:** 100k requests/day. **R2 free:** 10 GB + no egress.
- Provider pricing, data-use policy, model selection, and provider credentials are
  gateway concerns. Spool supplies the canonical client slug so gateway usage and
  quotas stay attributable; it must not add a provider key to work around them.

---

## Roadmap / next steps

1. **Switch models/providers** in `ai-worker`, not Spool. Keep Spool on task/tier
   requests so routing changes do not require an app deployment.
2. **Rate limiting / budget guardrails** — per-key daily cap via Cloudflare KV.
   (Hook point is in `worker/index.js` after auth.)
3. **Tighten CORS** — set `ALLOWED_ORIGINS` to your real domains instead of `*`.
4. **Custom domain for media** — put a domain on the R2 bucket so images serve
   directly (skips the Worker request count).
5. **Move uploads to R2 too** — today, *uploaded* images are still base64 in
   Firestore; generated ones go to R2. Unifying on R2 removes the 500 KB limit.
6. **Paid client tiers / permissions** — when ready, this is where API-key
   issuance (one key per project/client) and usage metering live, likely backed
   by D1 or KV.
