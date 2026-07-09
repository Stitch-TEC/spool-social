# Spool (spool-social) — CLAUDE.md

**What it is:** Spool — content drafting + client approval workflows (social / blog / job
posts). A React (Vite) SPA served by a single Cloudflare Worker (`worker/index.js`) that
also hosts the `/api` + `/media` routes. Data lives in **Firebase project `spool-social`**
(Firestore + Auth). Live at https://spool.stitchtec.dev.

**Suite role:** one of the 3 Stitch TEC apps (POM, **Spool**, Sender). Pre-launch,
internal-only (~6–11 clients). Calls the shared AI gateway under **appId `spool`**.

## Stack
React 19 + Vite 7 + Tailwind 4 + react-markdown · Firebase (Firestore/Auth) ·
Cloudflare Worker + R2 (`spool-media`) + KV (`RATE_LIMIT`) · service binding `AI` → ai-worker.

## Commands (exact — from package.json)
- `npm run dev` — Vite dev server (proxies `/api` + `/media` to `localhost:8787`)
- `npm run worker:dev` — `wrangler dev` (run alongside `npm run dev` for the API)
- `npm run lint` — `eslint .` (lints the WHOLE tree — **run before pushing**)
- `npm run test` — `vitest run` (jsdom) · `npm run test:watch` to watch
- `npm run build` — `vite build` → `dist/`
- `npm run deploy` — `npm run build && wrangler deploy` (manual fallback only)

## Deploy model
- **App auto-deploys** to Cloudflare Workers on push to `main` (`.github/workflows/deploy.yml`,
  auth via `CLOUDFLARE_API_TOKEN` repo secret; `VITE_FIREBASE_*` injected from Actions vars).
- `main` is **branch-protected**: PR + the `build` check (CI runs lint + test + build + audit).
  You cannot push straight to `main` — open a PR.
- **Firestore rules deploy MANUALLY** (CI does NOT ship them): `firebase deploy --only firestore:rules`
  (project `spool-social`). Source: `firestore.rules`.
- Worker **secrets stay server-side** (set via `wrangler secret put`, persist across deploys):
  `GEMINI_API_KEY`, `INTERNAL_API_KEY`, `FIREBASE_SERVICE_ACCOUNT`, `STITCH_AI_KEY`. Never commit values.
- Two cron triggers run in the Worker (`wrangler.toml [triggers]`): nightly R2 orphan GC (`0 4 * * *`)
  and due-automation draft generation (`*/15 * * * *`).

## Gotchas that bite
- **Node 25 here** → prefix wrangler: `NODE_OPTIONS=--dns-result-order=ipv4first wrangler ...`
- This env's main shell **cannot reach api.cloudflare.com** — run `wrangler dev/deploy` via a
  subagent or your own terminal, not the main shell.
- `wrangler deploy` ships the **working tree** but does NOT commit — commit source alongside deploys.
- AI **fails OPEN**: if any gateway call fails (or `STITCH_AI_KEY` is absent) Spool falls back to
  direct Gemini; multimodal (image-in) always goes direct. Instant revert = `wrangler secret delete STITCH_AI_KEY`.
- Auth **fails CLOSED**: anonymous/guest tokens are always rejected for generation + drafts.
- CI build needs dummy `VITE_FIREBASE_*` env (firebase.js calls `getAuth()` at module load).

## Suite invariants (load-bearing here)
- Client **SLUG is the universal join key**. ONE canonical roster: authored in
  `feedback-worker/src/clients.seed.json`, served by feedback-worker `GET /clients`. Spool PULLS it
  (`src/lib/clientsClient.js`) — do NOT mirror or fork the roster.
- ONE shared AI gateway (`ai.stitchtec.dev`, Claude-first, per-app key). Tier via `SPOOL_AI_TIER`.
- Firestore is multi-tenant by `clientId`; rules enforce per-client isolation server-side. Keep DB
  changes ADDITIVE. RBAC / client-teammate logins are built but gated — see `RBAC_DEPLOY_RUNBOOK.md`.

## File map
- `src/main.jsx` `App.jsx` — SPA entry + root.
- `src/components/` — UI (Editor, AIGenerate, MediaLibrary, CalendarView, AdminPanel,
  AutomationsPanel, FeedbackWidget, LoginScreen, …).
- `src/hooks/` — `useAuth` `usePosts` `useClients` `useToast`. `src/lib/` — `clientsClient.js`
  (roster pull), `feedbackClient.js`. `src/config/` — `firebase.js`, `roles.js`.
- `src/generation/prompts.js` — AI prompt builders. `src/stitch-apps.js` — shared app registry.
- `worker/` — `index.js` (router + cron `scheduled()`), `auth.js`, `firestore.js`, `gemini.js`
  (gateway + direct fallback), `media.js` (R2), `ratelimit.js`, `automation.js`, `suiteContext.js`.
  The curated media library is keyed by the canonical **slug** (`slugifyClient` in `index.js` maps a
  display name OR a slug to the same folder) so Spool's editor and POM's Assets card (via the
  feedback-worker broker `/spool/assets`) share ONE library. The internal key can only manage the
  OWNER namespace (`canManageKey`).
- `scripts/admin.mjs` — owner/RBAC CLI (needs a Firebase service-account key, kept out of repo).

## Deeper context
- This repo: `README.md`, `WALKTHROUGH.md`, `SPOOL_DRAFTS_API.md`, `SHARE_LINKS.md`,
  `RBAC_DEPLOY_RUNBOOK.md` / `RBAC_REFACTOR_BRIEF.md`, `CLOUDFLARE_MIGRATION.md`, `SUITE-TASKS.md`.
- Suite canon (at suite root): `SUITE-STATUS.md` (read first), `SUITE-ARCHITECTURE.md`,
  `AI-GATEWAY.md`, `STITCH-BRAND.md`, `IDENTITY-ACCESS-ROADMAP.md`, `STITCH-SUITE-ROADMAP.md`.
