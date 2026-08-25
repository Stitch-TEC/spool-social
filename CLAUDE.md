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
- `usePosts` RE-SUBSCRIBES on a retryable Firestore error (capped backoff) and reports
  `isStalled` when it can't — Firestore terminates a listener on error and never re-attaches,
  so the old "Retrying automatically…" banner was a lie. It also waits for `user` before
  opening a clientId-scoped listener (the guest listener used to race sign-in and die denied).
- **Known limit, not fixed:** the posts subscription is still UNBOUNDED — a cold load streams
  every post in the workspace. Bounding it needs pagination that the whole-workspace facet
  counts currently assume away. The grid window + density cap the RENDER cost, not the read.
- CI build needs dummy `VITE_FIREBASE_*` env (firebase.js calls `getAuth()` at module load).
- **Tailwind 4 emits arbitrary media variants BEFORE the named breakpoint scale**, so
  `min-[1600px]:grid-cols-4` silently loses to `xl:grid-cols-3` at every width where both
  match. Wide layout steps must use REGISTERED breakpoints — `@theme { --breakpoint-3xl }`
  in `src/index.css` (`3xl` = 1600px, `4xl` = 1920px) — which sort by value alongside sm–2xl.
- An `appearance-none` `<select>` keeps a UA-internal box that is TALLER than its padding
  in Safari (the label renders clipped by the bottom border). Every toolbar select goes
  through `SELECT_CLASS` in `src/utils/facetStyles.js`, which pins an explicit `h-8 py-0`.

## The review pipeline (2026-08-18 — read before touching the queue)
Spool has THREE axes, and until this date the UI conflated the first two:
- `status` — the WORKFLOW axis: `draft → scheduled → posted → archived`.
- `approvalStatus` — the CLIENT axis: `pending / approved / changes_requested`.
- **`reviewStage`** — the STAGING axis (new, additive): `private` | `in_review`.

**At runtime/rules, `reviewStage` ABSENT now fails client access closed.** Legacy
absence historically meant `in_review` for ordinary posts, while legacy
`source:'suggestion'` rows must backfill to `private`; the roster-aware
`scripts/admin.mjs review-stage --apply` makes those meanings explicit before the strict app/rules rollout. See
`REVIEW_STAGE_ROLLOUT.md`; its `id-inventory` compatibility gate runs first.
Never deploy the rules first, skip an incompatible legacy ID, or guess invalid values.

`src/utils/review.js` is the single derivation — `reviewStateOf()` folds the client-facing
axes into the four buckets the UI triages by: `not_sent · awaiting · changes · approved`.
An approval FACT (approved / changes_requested) outranks the stage, because it records
something the client did; pulling a post back to staging must not erase it.

- **New posts start `private`** (operator-authored; a client member's own post starts
  `in_review`). So do imports, blasts, clones, repurposed drafts, promoted suggestions,
  API-created drafts, and cron/automation output. Only the explicit **Send for review**
  verb (or `PATCH {reviewStage:'in_review'}`) puts a post in front of a client.
- **Only the OPERATOR sees staged posts** — enforced both by stage-constrained client
  queries and `firestore.rules`; `private` is now a real security boundary for guests
  and members. `App.jsx` still partitions the operator lanes. The guarded legacy
  backfill is a required pre-merge production step, not part of code deployment.
- **An edit invalidates an approval.** `handleSavePost` resets `approved → pending` when
  content/title/image/platform changed, and reads approval + feedback from the LIVE post (never
  from the editor's stale formData). Both downstream gates (publish-to-site, push-to-Sender)
  admit anything marked `approved` — that reset is what keeps them meaningful.
- **Review state never crosses a tenant boundary**: editor save, bulk client-reassign,
  and client MERGE clear approval, feedback/history, send time, and legacy reviewer
  attribution, then re-stage atomically with the tenant move (a pure RENAME does not —
  same client, new label). Any concurrent live `clientId` change aborts a stale editor
  save and requires reload—even when both editors chose the same destination—so copy
  prepared under the old tenant is never replayed into the new one. A concurrent
  same-ID display-label rename is preserved when the editor did not rename it.
- `worker/firestore.js countDraftSummary` counts `staged` separately from `pendingReview`,
  so POM's attention strip stops reporting drafts the client has never been shown.
- `src/utils/readiness.js` derives per-post blockers/warnings (needs an image, over the
  limit, no alt text, unscheduled, missing long-form fields). Memoized on post IDENTITY via
  a WeakMap — that only works because `usePosts` hands out referentially stable post objects.
  **Send for review refuses blockers, never warnings.**

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
- **Client lifecycle receivers (2026-08-17, internal key ONLY — same gate as `/api/people-sync`;
  driven by the broker's `POST /clients/lifecycle`, never by the SPA):**
  - `POST /api/client-rename {clientId, from?, to}` — relabels `posts.client` (+ `forClientId`
    suggestions), `shares.client`, `automations.client` where `clientId==slug`, and moves the OWNER's
    name-keyed branding doc to `clients/${OWNER_UID}__${encodeURIComponent(to)}`. Slug never changes.
  - `POST /api/client-purge {clientId}` — deletes posts/suggestions/shares/automations/users
    (super_admin docs left in place + noted)/branding for the slug + the R2 `library/<OWNER_UID>/<slug>/`
    folder. HARD delete — the broker guards it (archived-first, no billing/connections/seed rows).
  Both: slug-shaped `clientId` only, tenant-isolated by the `clientId` FIELD, idempotent, per-store
  `counts` + `errors[]` (never a silent success), one log line each.

## File map
- `src/main.jsx` `App.jsx` — SPA entry + root.
- `src/components/` — UI (Editor, AIGenerate, MediaLibrary, CalendarView, AdminPanel,
  AutomationsPanel, FeedbackWidget, LoginScreen, …). `FilterBar` is the grid toolbar
  (review-state chips + facet selects; it composes `PostControls` and hosts `DensityToggle`).
  `PostGrid` WINDOWS the list (page size per density: 48 cards / 72 compact / 150 rows,
  IntersectionObserver sentinel) — its `resetKey` prop must carry the filter context AND the
  density, never the list identity, or a snapshot yanks a scrolled operator to the top.
- **Feed DENSITY** (`constants.DENSITY`, `2026-08-20`): `cards` | `compact` | `list`. A pure
  VIEW preference — no stored field, no filter semantics — persisted per browser in
  `localStorage['spool.feedDensity']` (every access try/caught: Safari private windows throw).
  `compact` is `PostCard` with a 56px thumbnail beside two lines; `list` is its own component
  (`PostRow`, ~48px a row) which deliberately drops the verbs you'd only use after reading the
  whole post (clone-to-all, duplicate, hold, push-to-Sender, publish) — the row click opens the
  editor. **Review guests are pinned to `cards`** in BOTH App (the control is hidden) and
  PostGrid (the value is coerced): a one-line row invites approving copy the client only
  skimmed, so PostRow never has to reason about a read-only viewer.
- **Group headings** (`src/utils/grouping.js`): sticky month / client / platform runs over a
  long feed, on above `GROUP_MIN_POSTS` (12) posts and 2+ runs, else the grid renders flat.
  The group key MUST be the key the SORT orders by — that's what makes runs contiguous. In
  particular the scheduled sorts group by `scheduledDate || createdAt` (exactly usePosts'
  `_sortTs`); keying off `scheduledDate` alone dropped undated posts into an island that split
  a month into two identically-labelled runs. A heading's count is the run's TRUE size even
  when the window has only mounted part of it.
- `PostCard`'s hover action cluster is ABSOLUTE on `[@media(pointer:fine)]` and in flow on
  touch: eight `opacity-0` icon buttons still RESERVE ~190px of the header row, which is what
  used to wrap the platform/date/client onto three lines (and makes a 300px compact card
  impossible). Don't put it back in flow without re-checking the header at 300px.
- `src/utils/` — `review.js` (the review pipeline), `readiness.js` (per-post blockers),
  `helpers.js` (sorts, date formatters), `grouping.js` (feed group headings),
  `facetStyles.js` (shared toolbar select styling).
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
