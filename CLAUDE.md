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
  `GEMINI_API_KEY`, `INTERNAL_API_KEY`, `FIREBASE_SERVICE_ACCOUNT`, `STITCH_AI_KEY`, `CONTEXT_KEY`
  (the POM context/ideas seam — must match feedback-worker's). Never commit values.
- Two cron triggers run in the Worker (`wrangler.toml [triggers]`): nightly R2 orphan GC (`0 4 * * *`)
  and due-automation draft generation (`*/15 * * * *`).

## Gotchas that bite
- **Node 25 here** → prefix wrangler: `NODE_OPTIONS=--dns-result-order=ipv4first wrangler ...`
- ~~This env's main shell cannot reach api.cloudflare.com~~ — **FALSE (corrected 2026-07-14):**
  with the `NODE_OPTIONS` prefix, wrangler works from the main shell. Verify prod state directly.
- `wrangler deploy` ships the **working tree** but does NOT commit — commit source alongside deploys.
- AI **fails OPEN**: if any gateway call fails (or `STITCH_AI_KEY` is absent) Spool falls back to
  direct Gemini; **image-INPUT text generation always goes direct (UNMETERED — the suite's one live
  meter hole; image *generation* is gatewayed and honors the 429)**. Instant revert =
  `wrangler secret delete STITCH_AI_KEY` — but note that revert routes EVERYTHING through unmetered Gemini.
- Auth **fails CLOSED**: anonymous/guest tokens are always rejected for generation + drafts.
- CI build needs dummy `VITE_FIREBASE_*` env (firebase.js calls `getAuth()` at module load).

## Suite invariants (load-bearing here)
- Client **SLUG is the universal join key**. ONE canonical roster: **the LIVE roster is the
  Firestore `clients` collection** (the seed JSON is bootstrap/DR — corrected 2026-07-14), served
  by feedback-worker `GET /clients`. Consumers here: the SPA's `src/lib/clientsClient.js`
  (AdminPanel picker) and — load-bearing since 2026-07-29 — the worker's `fetchClientRoster`
  (`worker/suiteContext.js`), which **roster-repairs the clientId on 8 routes** (generate/text/
  ideas/page/content-index/site-image-import/automations; the publish lane hard-fails off-roster).
  **NARROWED FURTHER (PR #83, 2026-07-29):** the SPA's `clientIdFor` is now roster-aware too
  (stamped map → roster by normalized display name → slugify LAST resort, fail-open when the
  roster is unavailable), and the POM drafts join is **slug-keyed end to end** (the broker sends
  `clientId`; `GET /api/drafts` prefers it over the mutable name — a client rename no longer
  empties POM's card). Residual: a phantom slug is still possible only when the roster is
  unavailable (fail-open) or a display name drifts beyond case/whitespace normalization. Do NOT
  add new client-id resolution paths that skip the roster.
- ONE shared AI gateway (`ai.stitchtec.dev`, Claude-first, per-app key). Tier via `SPOOL_AI_TIER`.
- **POM context/brand/ideas seam** (all server-side via `CONTEXT_KEY` → feedback-worker; the key
  never reaches the browser): generation injects the client profile (aiContext, structured
  `brandKit` palette/theme, auto-refreshed `recentActivity` digest, asset manifest) into prompts;
  `GET /api/ideas?client=` brokers `/client-signals` (site pages + repo releases/commits) for the
  editor's Ideas panel. Fail-OPEN: no `CONTEXT_KEY` = no injection + `{ok:false,
  error:'not_configured'}` from /api/ideas (panel hides). ALL fetched site/repo text is rendered
  as untrusted data by the `renderPom*` helpers in `src/generation/prompts.js` — keep that framing.
- Firestore is multi-tenant by `clientId`; rules enforce per-client isolation server-side. Keep DB
  changes ADDITIVE. RBAC / client-teammate logins are built but gated — see `RBAC_DEPLOY_RUNBOOK.md`.
- **Shipped lanes not listed above (added 2026-07-29):** the **publish lane** (#80 —
  `/api/publish-to-site`, operator-only, approved blog drafts → broker `/spool/publish-draft` →
  exact-bytes agent PR); **content-index consumption** (#79 — `/api/content-index`,
  `/api/site-image-import`, `/api/page`, seoKit in prompts, MediaPicker "Client site" section);
  the **suggestion/auto-draft lane** (`source:'suggestion'` + `forClientId` tenant-key semantics in
  `App.jsx:252-260` — load-bearing, don't break); **brainstorm/SparkDeck** (#76); the attention
  seam (`/api/drafts?summary=1`); **push-to-Sender** (`/api/sender-template`).

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
  `RBAC_DEPLOY_RUNBOOK.md` / `RBAC_REFACTOR_BRIEF.md`, `CLOUDFLARE_MIGRATION.md`.
- Suite canon (at suite root): `SUITE-STATUS.md` (read first), `SUITE-ARCHITECTURE.md`,
  `AI-GATEWAY.md`, `STITCH-BRAND.md`, `IDENTITY-ACCESS-ROADMAP.md`, `STITCH-SUITE-ROADMAP.md`.
