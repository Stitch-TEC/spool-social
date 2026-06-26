# Spool (spool-social) — Suite Tasks

> **STATUS — 2026-06-22:** Suite build-guide **steps 0–5 are built, deployed, and verified live** across
> all four apps (registry, switchers, POM tickets model, feedback Worker at feedback.stitchtec.dev,
> feedback widgets, and email→ticket). POM is rebranded + live at pom.stitchtec.dev. **Current focus:
> a ground-up POM (Site-Auditor) redesign** — the data lands correctly but POM's display layer needs
> rework. See **../SUITE-STATUS.md** (the snapshot) and **../POM-REDESIGN-BRIEF.md**. Monthly reports (step 6)
> and per-client API keys (step 7) are **deferred — not a priority**. This doc is kept for detail/history;
> where it frames work as "to do," treat it as done unless ../SUITE-STATUS.md says otherwise.

> Part of the suite build. Master order + the big picture: ../SUITE-BUILD-GUIDE.md. Specs: ../SUITE-SHARED-COMPONENTS-PLAN.md, ../SUITE-INTEGRATION-ARCHITECTURE.md, ../STITCH-BRAND.md.

## What this repo contributes
Spool already ships a cross-app switcher (`ToolSwitcher.jsx`) and its OWN Gemini AI Worker (Spool-specific — NOT the planned shared suite AI service; `ai.stitchtec.dev` currently serves only Spool, and a Claude-first shared worker is still unbuilt). Its suite-build job is small and additive: reconcile the switcher to the shared registry (fixing the POM URL) + show it to logged-in clients, and add the floating feedback widget (distinct from the existing per-post client review flow). No tickets/email work lives here.

> Branch note: there is an active RBAC refactor on `feat/content-automation`. These tasks are **additive UI** — do NOT touch RBAC logic in `useAuth.js`/`config/roles.js`. The widget only *reads* identity that `useAuth` already returns.

## Tasks — do in this order

### Task 1 — Reconcile the switcher to the shared registry + show to clients  (master steps 0 + 1)  ✅ done/deployed (done 2026-06-22 — see ../SUITE-STATUS.md)
**Does:** Replaces Spool's local hardcoded app list with the canonical `STITCH_APPS` registry (one source of truth, correct POM URL), and stops hiding the switcher from logged-in client users.
**Needs:** The `STITCH_APPS` shape from SUITE-SHARED-COMPONENTS-PLAN.md §2 (master step 0). Nothing cross-repo blocks this.
**Where (confirmed paths in this repo):**
- `src/constants.js` lines 122–127 — current `export const STITCH_SUITE = [...]` (POM marked `comingSoon`, wrong/aspirational `pom.stitchtec.dev` URL, missing the `site` entry).
- `src/components/ToolSwitcher.jsx` — imports `{ STITCH_SUITE }` from `../constants` (line 3); maps over it (lines 30–48); keys off `app.comingSoon` and `app.current`.
- `src/components/DashboardHeader.jsx` line 38 — `{!isReadOnly && <ToolSwitcher />}` (this is the operator-only gate).

**Steps:**
1. Create the registry copy at `src/stitch-apps.js` (Vite/JS app → `.js`, not `.ts`), exporting `STITCH_APPS` exactly per §2 — include all four apps (`site`, `pom`, `spool`, `sender`), `status` field, and POM url = `https://stitch-command.web.app` (recommended default — change if you decided otherwise). Also export `export const CURRENT_APP_ID = 'spool';`.
2. Delete `STITCH_SUITE` from `src/constants.js` (lines 122–127). Grep for other importers first: `grep -rn "STITCH_SUITE" src/` — only `ToolSwitcher.jsx` should reference it.
3. Update `ToolSwitcher.jsx`: import `{ STITCH_APPS, CURRENT_APP_ID }` from `../stitch-apps`; map over `STITCH_APPS`. Translate the old field names to the registry shape:
   - `app.comingSoon` → `app.status === 'soon'`
   - `app.current` → `app.id === CURRENT_APP_ID` (compute a local `current` per row; the registry has no per-app `current` flag)
   - keep the existing light-theme Tailwind styling and the outside-click `useEffect`; add **Escape-to-close** (spec §3) — extend the existing `onDoc` effect with a `keydown` listener that closes on `e.key === 'Escape'`.
4. In `DashboardHeader.jsx` line 38, change the gate so the switcher shows to logged-in operators **and** clients, but stays hidden in the read-only guest review view. The component already receives `isReadOnly`; line 38 is currently `{!isReadOnly && <ToolSwitcher />}` — that is already correct for "hide only from guests" **once** the gate's intent is confirmed: `isReadOnly` is true only for share-link guests (per `useAuth.js`), so `!isReadOnly` = operators + logged-in clients. Verify against `useAuth` that client members are *not* `isReadOnly` (they aren't — `isReadOnly` is the guest/share path). If confirmed, the only real change here is leaving line 38 as-is; if any other client-hiding gate exists, remove it. (The plan's "gated to operator via `!isReadOnly`" assumption conflates client with guest — confirm and note the resolution.)

**Done when:** Switcher shows POM/Sender/Spool/Site rows from `STITCH_APPS` with Spool marked current (check, non-link), POM points at `https://stitch-command.web.app`, soon-apps render disabled, Escape + outside-click close the panel, and a logged-in *client* (non-operator, non-guest) sees the switcher while a share-link guest does not. `grep -rn "STITCH_SUITE" src/` returns nothing.

### Task 2 — Add the floating feedback widget  (master step 4)  ✅ done/deployed (done 2026-06-22 — see ../SUITE-STATUS.md)
**Does:** Adds the suite floating feedback button + modal to Spool's authenticated shell, posting the standard payload to the shared feedback endpoint. Separate from the per-post review/change-request flow.
**Needs:** master step 3 (the feedback ingress endpoint) live and CORS-allowing `https://spool.stitchtec.dev`. Registry (`CURRENT_APP_ID`) from Task 1. Identity comes from `useAuth` (no new auth work).
**Where (confirmed paths in this repo):**
- New component `src/components/FeedbackWidget.jsx`.
- Mount in the app shell. Cleanest mount is `src/App.jsx` near the existing `<Toast />` render (Toast is imported line 25, `useToast` line 18), so the widget floats over all authenticated views regardless of `view` (`grid`/`calendar`/`editor`). Mounting in `DashboardHeader.jsx` also works but App.jsx gives a stable bottom-right overlay.
- Identity source: `useAuth` (`src/hooks/useAuth.js` return block lines 166–181) exposes `user` (Firebase user → `user.email`), `role`, `clientId`, `isOperator`, `isReadOnly`. **Note:** `App.jsx` line 43 currently does **not** destructure `role` — add `role` (and `clientId` is already aliased as `myClientId`) when wiring the widget.
- Version: `package.json` version is `0.0.0` and there is no build-id env today. Use `import.meta.env.VITE_APP_VERSION` with a fallback string (e.g. `'spool@dev'`); wiring a real build id is optional/out of scope.

**Steps:**
1. Build `FeedbackWidget.jsx`: floating bottom-right button (`MessageSquare` from lucide-react, already a dep) → modal with category select (`Bug`/`Idea`/`Other`), required free-text message (~1000 char cap — reuse the `CharCountCircle` pattern if convenient), and a read-only context block showing what will be sent (app, page, user, viewport). Match Spool's light theme (white card, `rounded-xl`, indigo accent) — keep layout identical to spec §4, surface per Spool.
2. Auto-capture context at submit time:
   - `app: CURRENT_APP_ID` (`'spool'`), plus app name from the registry.
   - `page: window.location.href`, `route: window.location.pathname` (Spool is a single-route SPA; also include the active `view` value if you pass it in, since route alone won't distinguish grid/calendar/editor).
   - `user: user?.email || 'anonymous'`, plus `role` and `clientId` (`myClientId`) for triage.
   - `appVersion`, `userAgent: navigator.userAgent`, `viewport: \`${innerWidth}x${innerHeight}\``, `ts: new Date().toISOString()`.
3. POST the §4 payload as JSON to the feedback endpoint. Add the base URL as `import.meta.env.VITE_FEEDBACK_URL` (follow the existing `VITE_*` convention in `src/config/`), defaulting to `https://feedback.stitchtec.dev/feedback`. On success → `showToast('Thanks — feedback sent')`; on error → toast an error and keep the modal open / preserve the typed message (don't lose it).
4. Mount in `App.jsx`: render `<FeedbackWidget user={user} role={role} clientId={myClientId} view={view} />` next to `<Toast />`, only for authenticated non-guest sessions (guard with `user && !isReadOnly`). Pass `showToast` down or import `useToast` inside the widget — match the existing pattern (App owns the single `useToast`).
5. v1 capture = text + auto-context only (recommended default — change if you decided otherwise). No screenshot/console capture (that's v2).

**Done when:** A logged-in user sees the floating Feedback button on grid/calendar/editor views (not in the guest review view), the modal sends the §4-shaped payload to the endpoint, a success toast fires, errors preserve the message, and the per-post review/change-request flow is untouched. Verify the payload shape matches a Sender/POM submission (one inbox, one shape).

## Conventions to honor
- **Registry:** the shared `STITCH_APPS` shape (SUITE-SHARED-COMPONENTS-PLAN.md §2) — `{ id, name, tagline, url, status }`, `CURRENT_APP_ID='spool'`. Copy, don't share a package (integrate at the seams).
- **Feedback payload:** the exact §4 shape (`app, category, message, page, route, user, appVersion, userAgent, viewport, ts`) so every app feeds one inbox / one POM ticket store in one shape.
- **Brand tokens:** STITCH-BRAND.md — Spool is light-themed; keep its surface but identical structure to the other apps' widgets.
- **Identity = email, validated by POM.** Spool just reports `user.email` + `role` + `clientId`; it does not invent client identity. Don't modify `useAuth.js`/RBAC (active refactor on `feat/content-automation`).
