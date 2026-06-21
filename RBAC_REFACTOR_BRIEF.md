# Spool — Client Users & Permissions Refactor (handoff brief)

**Author:** scoping pass, 2026-06-19 · **For:** a scoped Spool implementation task · **Repo:** `spool-social`

> Read this whole file first. It is self-contained — assume no prior conversation. Mirror the patterns already proven in two sibling apps in this suite (paths in **Reference implementations**): **Site-Auditor** is the primary template (same Firebase/Firestore stack), **Sender** is the role-semantics blueprint.

---

## 1. Goal (plain English)

Today Spool is single-operator: only the owner (Google sign-in) creates content; everyone else is a read-only review guest via a `?s=` link. We want **client users**:

- A client's own people can **sign in, and create / edit / delete their client's content** and **generate review links** — not just review.
- They are **scoped to their own client only** — they never see other clients or any operator/admin surfaces.
- **Multiple users in the same client share that client's content** (client-scoped, not per-user).
- The existing **read-only `?s=` review-link flow stays exactly as is** (external reviewers with no account).

This is the same shape Sender and Site-Auditor already ship: an **operator** who sees everything, **client users** scoped to one client, enforced server-side.

---

## 2. Current Spool model (what exists today — verified against code)

- **Auth:** operator signs in with **Google** (Firebase Auth, `useAuth.js`); a workspace *is* one Firebase `uid`. Review guests open a `?s=<token>` link → Worker `/api/share/session` mints a **Firebase custom token** with claims `{ share:true, shareOwner, shareClient }` → `signInWithCustomToken`. Legacy `?uid=&client=` links use anonymous auth (being retired).
- **Roles:** none named. Implicit two-role: **owner** (full CRUD over docs where `uid == their uid`) vs **review guest** (the `share` claim → read + approve/request-changes/feedback only). The only gate is `isReadOnly = !!shareScope && user.uid !== shareScope.ownerUid` (`useAuth.js:78`).
- **Data:** `posts/{autoId}` (fields incl. `uid` = **owner uid**, `client` = **free-text string**, content, status, approvalStatus, feedbackThread…); `clients/{uid}__{name}` (branding/AI defaults); `shares/{token}` (Worker-only). **Everything is keyed to the operator's `uid`; `client` is just an editable string, not an identity.** R2 media keys are `…/<uid>/<client>/…`.
- **Isolation:** `firestore.rules` is the authoritative boundary — `isOwner(uid)`, `isShareGuest(uid,client)`, `isGuestReviewUpdate()` (field-level allowlist `['status','approvalStatus','feedback','feedbackThread','updatedAt']`). The app must query-scope (`usePosts.js` adds `where('uid','==')` + `where('client','==')`) so rules resolve.

**Why a refactor is needed (the gaps):** no client-user accounts; no membership/role record; content is keyed to the *operator* uid (a client user has a different uid → `isOwner()` fails → they can read/create nothing); guests are hard-limited to review-only; the single binary `isReadOnly` can't express "client editor"; and the free-text `client` string is **not safe as a security key** (user-editable, not unique across owners).

---

## 3. Target model

### Roles (three-tier; mirror Site-Auditor's `users/{email}.roles[]` + Sender's tuple semantics)
| Role | Who | Can |
|---|---|---|
| `super_admin` | You (Dillon), the master | Everything, all clients/entities, all surfaces. Assigns every other user's role + `clientId`. (today's owner) |
| `client_admin` | An admin of one client/entity | Everything `client` can do, **plus** (phase 2) add/manage users **within their own `clientId` only**. |
| `client` | A member of one entity | CRUD **only their own entity's** content; create/revoke **their entity's** review links. No other entities, no operator surfaces. |
| *(reviewer guest)* | External, no account | Unchanged — existing `?s=` read + approve/feedback flow. |

("entity" = a client/tenant. `super_admin` is the operator/owner throughout this doc.)

### Phasing (ship the data model for all three roles now; wire provisioning in two steps)
- **Phase 1 (now):** define all three roles. **Only `super_admin` writes `users/{email}` docs** — you add everyone manually (assigning `client_admin` or `client` + their `clientId`). No client-side user management UI yet.
- **Phase 2 (later, designed-for now so it's no rework):** enable a `client_admin` to add/manage users **scoped to their own `clientId`** — reusing Sender's team-management guard clauses (can't grant `super_admin`, can't touch users outside their own entity, no self-lockout, audit-logged).

Building the role set + rules to accommodate `client_admin` now means phase 2 is just "turn on the entity-scoped invite UI + endpoint," not a re-model.

### The structural fix: introduce a stable `clientId`
- Add a **stable, immutable `clientId` slug** per client (e.g. `cadden`, `omni-nde`, `the-bdr`). This — **not** the free-text `client` name — is the tenant boundary, and it is the suite-wide client key (see §7 seams).
- Add `clientId` to `posts` and to the `clients` record; backfill existing docs (§6 migration).
- Authorization for a client user comes from a **`users/{email}` doc** (mirror Site-Auditor): `{ roles: ['client'], clientId: 'cadden' }` for a client user, `{ roles: ['operator'] }` for you. Email is the identity key (lowercased), matching the rest of the suite.

### How client users authenticate
Reuse the **existing Firebase Auth** (Google and/or magic-link — copy Site-Auditor's `AuthContext` which supports both). On sign-in, resolve the `users/{email}` doc:
- has `operator` → full app (today's behavior).
- has `client` + `clientId` → scoped client experience.
- review `?s=` token → existing guest flow (unchanged).
- none → deny with a clear "not authorized" message.

No new login system — just add the `users/{email}` authorization gate on top of Firebase Auth, exactly like Site-Auditor.

---

## 4. Implementation plan

**A. Data model**
1. Add immutable `clientId` to `posts` and `clients`; treat `client` (display name) as a mutable label only. **Re-key `clients` doc id to `clientId`** (decided 2026-06-19 — you're migrating anyway, so do it once; rename then = a field update, not a doc re-key). Update every `${uid}__${name}` reference (`ClientSettingsModal.jsx`, `usePosts` clientMap) and the guest branding read (see note in §6).
2. Create `users/{lowercased-email}` docs: `{ roles: string[], clientId?: string }`. (Optionally also a `clientMembers` map; the `users/{email}` doc is the simpler, Site-Auditor-proven choice.)

**B. `firestore.rules` (authoritative — do this first, it's the real boundary)**
Add helpers mirroring Site-Auditor: `getUserEmail()` (`.lower()`), `getUserRoles()` and `getUserClientId()` (via `get()` on `users/$(email)`), `isSuperAdmin()`, `isClientAdmin(clientId)`, and `isEntityMember(clientId)` (= `super_admin`, OR a `client`/`client_admin` whose `getUserClientId() == clientId`). Then:
- `posts` — `read: isSuperAdmin() || isEntityMember(resource.data.clientId) || isShareGuest(...)`; `create: isSuperAdmin() || isEntityMember(request.resource.data.clientId)` with `clientId`/owner immutable; `update: isSuperAdmin() || (isEntityMember(resource.data.clientId) && clientId unchanged) || isGuestReviewUpdate()`; `delete: isSuperAdmin() || isEntityMember(resource.data.clientId)`.
- `clients/{id}` — `read: isSuperAdmin() || isEntityMember(thatClientId)`; `write: isSuperAdmin()` (let a `client_admin` edit their own brand voice only if you decide to — `super_admin`-only by default).
- `users/{email}` — `read: isAuthenticated() && getUserEmail()==email` (resolve own role). **Phase 1 write: `isSuperAdmin()` only.** **Phase 2 write:** also allow a `client_admin` to write a `users` doc **only when** the target's `clientId == ` the admin's own `clientId` **and** the role being set is `client`/`client_admin` (never `super_admin`) — i.e. entity-scoped, no escalation. **Self-promotion lockout always:** a user may read their own doc but may never write their own role/`clientId`.
- `shares/{token}` — stays Worker-only (`if false`); see endpoint change in D.
- Keep all existing `isShareGuest` / `isGuestReviewUpdate` rules so the review flow is untouched.

**C. App / UI gating (`App.jsx`, `useAuth.js`, `usePosts.js`)**
- Replace the binary `isReadOnly` with a capability derived from role: `operator` | `clientMember` | `reviewer`.
- `usePosts.js`: for a client member, scope queries by `where('clientId','==', myClientId)` (the rules-compliant query, like Site-Auditor's `where('name','in',chunk)` pattern).
- Hide operator-only surfaces from client members: the all-clients picker (force to their `clientId`), client **rename/merge**, **cross-client bulk reassign**, **clone-to-all-clients**, **import**, and other clients' media library. **Keep** a scoped editor and a scoped ShareManager so they can create their own review links.
- Reviewer-guest rendering stays as-is.

**D. Worker (`worker/index.js`, `worker/auth.js`) — REQUIRED workstream (correction, 2026-06-19)**
> An earlier draft said the Worker needed no change. That was wrong: `/api/media` + `/api/generate` are dual-auth and are called **from the browser with a Firebase token** (`generationApi.js`), R2 media keys are `library/<uid>/<client>/` (personal-uid-keyed), and `ALLOWED_EMAILS` is empty (so any Google account currently passes the gate to paid generation + R2). The moment real client users sign in, that's both a DoD violation (media wouldn't be shared per entity) and an open paid-generation hole. So:
- **Resolve `role` + `clientId` server-side** from `users/{email}` (the Worker already has service-account Firestore access) and reject non-whitelisted callers from generation/media.
- **Key media by `clientId`** (not the caller's uid) so an entity's media is shared across its members and visible to the operator. New uploads only — see migration note (don't bulk-move existing R2 objects; old `imageUrl`s must keep resolving).
- `/api/share` create: when called by a `client`/`client_admin`, **force `ownerUid` to the operator and `clientId` to the caller's own** (don't attribute links to the client user's uid). Operator path unchanged.

**E. Super-admin admin UI (mirror Site-Auditor `AdminPanel.jsx`)**
A `super_admin`-only screen to **grant/revoke users**: enter email → pick role (`client_admin` | `client`) → pick `clientId` → `setDoc(users/{email}, {roles:[role], clientId})`; revoke = `deleteDoc`. This is how you (the master) onboard everyone in phase 1.
- **Phase 2 (later):** add an entity-scoped variant for `client_admin` — same UI, but it can only set role `client`/`client_admin` and only for its own `clientId`, with Sender's guard clauses (no escalation to `super_admin`, no self-lockout, audit-logged). Build the data model/rules for this now (§3 phasing); wire the UI later.

**F. Migration**
One-time backfill: add `clientId` to every existing `post` and `client` doc by mapping the current free-text `client` names → stable slugs. Keep the operator's existing `uid`-keyed access working throughout (operator rules still allow `isOwner(uid)`); `clientId` is additive.

---

## 5. Definition of done (acceptance criteria)
- A `client` user signs in and sees **only** their client's content; can create, edit, delete it; can generate a review link for it.
- Two `client` users with the same `clientId` see and edit the **same** content.
- A `client` user **cannot** see other clients, the all-clients view, client rename/merge, cross-client bulk, import, or any operator-only control — verified, and **enforced in `firestore.rules`**, not just hidden in the UI.
- No client user (`client` or `client_admin`) can self-promote or escalate to `super_admin`; a user can never write their own `users/{email}` doc. In phase 1, only `super_admin` writes any `users` doc.
- The operator experience is unchanged; the existing `?s=` reviewer flow is unchanged.
- Rules are deployed **with/before** the app (see gotchas), and a cross-client read/write is proven to be denied.

## 6. Gotchas / must-not-break
- **Never use the free-text `client` string as the security key** — only the immutable `clientId`.
- **`firestore.rules` is the boundary; UI gating is cosmetic.** Every client-scoped action must be enforceable by rules against a tamper-proof field (`clientId`), not the editable name.
- **Rules-vs-app deploy ordering** (`SHARE_LINKS.md`): deploy rules with the app, or you get a window where new app code hits old permissive rules. Automate the `firestore.rules` deploy in CI if it isn't already.
- **Disable Firebase Anonymous sign-in** (legacy `?uid=` links) — the new model must not depend on it.
- `get()`-based rule reads (resolving `users/{email}`) cost one read per eval — fine at this scale (same as Site-Auditor).
- Renaming a client's display name must NOT change `clientId` (Site-Auditor's name-based scoping has this fragility — we avoid it by using a stable id).
- **Re-keying `clients` to `clientId` touches the guest branding read.** Today a reviewer guest resolves branding by the `client` *name* (their share token carries `shareClient = name`). After re-key, either (a) add `clientId` to the share-token claims when minting, or (b) keep a name→`clientId` resolution for guests. Don't let the reviewer flow regress.
- **Don't bulk-migrate R2 media objects.** Switch *new* uploads to `clientId` keying; leave existing objects and stored `imageUrl`s as-is so they keep resolving. A bulk R2 move risks breaking every existing post image.
- **Decide `uid` attribution for client-created posts** and the `feedbackThread` `by:'you'|'client'` labels now that client users are real authors (not just reviewers). `clientId` is the security key regardless; `uid` becomes attribution only.

## 7. Suite seams to honor (so this composes later, no rework)
This refactor must align with the wider Stitch Suite plan (`../STITCH-SUITE-ROADMAP.md`):
- **Email is the universal join key** — client users are identified by email (lowercased), matching Sender and Site-Auditor.
- **`clientId` is the stable client-record key** — pick Spool's own stable, **immutable** `clientId` per entity now; do **not** try to coordinate slugs with the other tools yet. Cross-tool slug reconciliation is deliberately deferred to a later "link layer" pass. The only requirement here: keep `clientId` stable/immutable and resolvable from email, so that later reconciliation is a mapping, not a migration.
- Don't invent a Spool-only identifier that can't map back to email + `clientId`.

---

## 8. Reference implementations (read these — don't reinvent)

**Site-Auditor (PRIMARY template — same Firebase/Firestore stack):**
- `../Site-Auditor/firestore.rules` — `getUserEmail()/getUserRoles()/getClientSites()/isAdmin()/isClient()` helpers; per-collection role+scope gates; the self-update lockout (`users` read-own / operator-write). **Copy this structure**, swapping `clientSites`(name-array) → `clientId`(single stable id).
- `../Site-Auditor/src/contexts/AuthContext.jsx` — Google + magic-link sign-in, fetch `users/{email}`, derive `isAdmin/isClient` + scope, hard-deny un-whitelisted accounts.
- `../Site-Auditor/src/contexts/DataContext.jsx` — admin reads all; client issues scoped `where(...)` queries matching the rules.
- `../Site-Auditor/src/components/AdminPanel.jsx` — grant/revoke users (`setDoc(users/{email}, {roles, scope})` / `deleteDoc`); scope field shown only for the client role. Template for §4E.

**Sender (role-semantics blueprint — different stack, copy the *shape*):**
- `../Stitch-Sender/apps/web/src/lib/authz.ts` — `SENDER_ROLES` const tuple (client read-only by exclusion), `requireAuth/requireRole(roles,msg)/requireTenantManager(tenantId)`, `isAuthError`, `checkOrigin` CSRF. Mirror the "operator manages any client; client manages only its own" rule.
- `../Stitch-Sender/apps/web/src/app/api/tenants/[id]/users/route.ts` — team management guards worth copying if/when you add `client_admin` self-invite: no self role-change, no escalation to operator, last-manager guard, audit log.
- `../Stitch-Sender/apps/web/src/app/dashboard/campaigns/page.tsx` — the read-only gating UX (`canEdit = roles.includes(...)` → action vs "read-only, ask an admin").

**Spool files to change:**
- `firestore.rules` (the core change), `src/hooks/useAuth.js`, `src/hooks/usePosts.js`, `src/App.jsx`, `worker/index.js` (`/api/share` create), `worker/auth.js`, `src/components/ShareManager.jsx`, `src/components/ClientSettingsModal.jsx`, plus a new operator admin screen and a client-user provisioning path. Background: `SHARE_LINKS.md`, `SPOOL_DRAFTS_API.md`.
