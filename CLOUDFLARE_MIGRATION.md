# Spool → Cloudflare migration + generation API

This branch (`feat/cloudflare-worker`) moves Spool off GitHub Pages and onto a
single **Cloudflare Worker** that serves the app *and* exposes an image/text
generation API powered by **Google Gemini**, with generated images stored in
**Cloudflare R2**.

Firebase (Auth + Firestore) is unchanged — the app still uses it directly from
the browser. Only hosting moved, plus the new API.

---

## Architecture

```
                        ┌──────────────────────────────────────┐
   Browser (Spool SPA)  │           Cloudflare Worker           │
   ───────────────────► │  GET  /              → static assets  │
     Firebase ID token  │  GET  /media/<key>   → R2 image       │
                        │  POST /api/generate  → Gemini → R2    │
   Your other projects  │  POST /api/text      → Gemini         │
   ───────────────────► │  (auth: Firebase token OR API key)    │
     INTERNAL_API_KEY   └───────────────┬───────────────┬───────┘
                                        │               │
                                  Google Gemini      R2 bucket
                                  (text + image)    (spool-media)

   Firestore + Firebase Auth  ◄──── still used directly by the SPA
```

**Why this shape:** the in-app feature and the reusable API are the same Worker.
Spool is just its first client; your other projects call the same endpoints with
an API key.

---

## What's in this branch

| File | Purpose |
|---|---|
| `wrangler.toml` | Worker config: static assets, R2 binding, vars |
| `worker/index.js` | Router: `/api/generate`, `/api/text`, `/media/*`, SPA fallback |
| `worker/auth.js` | Dual auth — Firebase ID-token verification + internal API key |
| `worker/gemini.js` | Gemini text + image calls |
| `src/utils/generationApi.js` | Front-end client (sends the user's Firebase token) |
| `src/components/AIGenerate.jsx` | Inline "Generate image" / "AI draft" control |
| `src/components/Editor.jsx` | Wired the two controls into the editor |
| `vite.config.js` | `base: '/'` for Worker hosting + dev proxy to `wrangler dev` |
| `package.json` | `deploy` now targets Cloudflare; `deploy:pages` kept for legacy |

---

## One-time setup

Prereqs: a Cloudflare account (your Stitch TEC account is fine) and a Google AI
Studio / Gemini API key.

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
npx wrangler secret put GEMINI_API_KEY      # from Google AI Studio
npx wrangler secret put INTERNAL_API_KEY    # a long random string you invent
```

Generate a strong internal key with: `openssl rand -hex 32`

---

## Deploy

```bash
npm run deploy      # builds the SPA, then `wrangler deploy`
```

Wrangler prints a URL like `https://spool.<your-subdomain>.workers.dev`.
Add a custom domain later in the Cloudflare dashboard (e.g. `app.stitchtec.com`).

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

## Cost recap (June 2026)

- **Cloudflare Workers free:** 100k requests/day. **R2 free:** 10 GB + no egress.
- **Gemini free tier:** ~1,500 requests/day on Flash models — good for testing.
- **Per image (paid):** Imagen 4 Fast ~$0.02, Gemini 3 Flash Image ~$0.067,
  Gemini 3 Pro Image ~$0.134. Text Flash calls are a fraction of a cent.

⚠️ **Free-tier data caveat:** Gemini's free tier may use your prompts/outputs to
improve Google's models. Fine for testing — **enable billing before client work**
(also removes the training use). Set a low daily quota on the key in Google Cloud
to cap spend.

---

## Roadmap / next steps

1. **Switch models** to current-gen (`gemini-3.1-flash-image` / `gemini-3-pro-image`)
   once billing is on — just edit `wrangler.toml`, no code change. (The default
   `gemini-2.5-flash-image` is slated to sunset Oct 2026.)
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
