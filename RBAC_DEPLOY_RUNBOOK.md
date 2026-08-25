# Spool RBAC — Deploy Runbook (Phase 1: data model + rules + backfill)

This is the **ordered** procedure for shipping the security boundary. Order is
load-bearing: several Firestore rules flip to `isSuperAdmin()`, which reads your
`users/{email}` doc — deploy the rules before that doc exists and **you lock
yourself out of provisioning.** Do the steps in sequence; don't skip the audit.

> **Current-rules addendum (2026-08-24):** `firestore.rules` now also enforces
> `reviewStage` as a client/guest visibility boundary. Before deploying the
> current file, follow [`REVIEW_STAGE_ROLLOUT.md`](REVIEW_STAGE_ROLLOUT.md): strict
> ID/owner/tenant inventory → guarded stage + `updatedAt` backfill → deploy the
> declared index and wait READY → freeze review actions → **feedback-worker
> first → POM second → final Spool third → immediate rules deploy → contract and
> private/in-review checks → R2/cache verification**. A temporarily fail-closed
> old POM Content card is accepted; no approval action is allowed during the
> window. That sequence supersedes Step 1 below for this revision; deploying the
> current rules before the backfill/app would hide legacy posts and deny old
> client query shapes.

> What's now implemented (working tree, pending deploy): `firestore.rules`, the
> `users/{email}` model + `clientId` backfill, the role-aware app
> (`useAuth`/`usePosts`/`App.jsx` gating + the operator "Manage Users" screen),
> and the Worker (`/api/share` owner-binding + `clientId` re-key,
> `/api/share/session` `shareClientId` claim). **Client logins are safe to enable
> only after the audit below is clean and links are re-issued.**
>
> Still deferred (operator unaffected): **per-client media is operator-only** — the
> R2 library is still keyed per-uid, so client members don't get the media panel
> yet (re-keying R2 to `clientId` is a separate migration). The `clients` doc-id
> re-key to `clients/{clientId}` is also deferred (the backfilled `clientId` *field*
> already scopes branding reads, so it's a cleanup, not a blocker).

> ✅ **Guest re-key shipped (the former blocking precondition is resolved).** The
> `?s=` guest review read now matches on the immutable `clientId` (a `shareClientId`
> token claim), not the display name — so a client member can no longer surface a
> forged-name post in another tenant's review queue. Adversarially re-verified.
> **Consequence:** review links minted *before* this change carry no `shareClientId`
> and now **fail closed** — re-issue all outstanding `?s=` links after deploy (Step 5).

## Prerequisites
- A Firebase **service-account key** locally (the same identity as the Worker's
  `FIREBASE_SERVICE_ACCOUNT` secret). Download a fresh one if needed: Firebase
  console → Project settings → Service accounts → *Generate new private key*.
  Save it **outside the repo** (it's a secret; `.gitignore` already excludes dotfiles
  but a stray `*.json` key is not — keep it elsewhere). Referenced below as `sa.json`.
- Operator email (the Google account you sign into Spool with): **dillon@stitchtec.dev**.

## Step 0 — Bootstrap your super_admin doc (BEFORE rules)
Out-of-band write via the service account (bypasses rules), so it works while the
*old* rules are still live.
```bash
node scripts/admin.mjs bootstrap --email dillon@stitchtec.dev --key sa.json
```
Creates `users/dillon@stitchtec.dev = { roles: ['super_admin'], email, … }`.
(Console fallback if you'd rather click: create collection `users`, doc id
`dillon@stitchtec.dev`, field `roles` = array `['super_admin']`, field `email` =
`dillon@stitchtec.dev`.)

## Step 1 — Rules deployment point (defer for the current revision)

For the current code, **do not run this command here**. First complete the
guarded data/id/tenant/stage/`updatedAt` audit and backfill, deploy the declared
index and wait READY, then use the frozen feedback-worker → POM → Spool order in
`REVIEW_STAGE_ROLLOUT.md`. Run the command only immediately after the final
Spool deploy, while review actions remain frozen:

```bash
firebase deploy --only firestore:rules        # test in the Rules Playground first
```
What changes the instant this lands:
- You (super_admin) and the legacy `isOwner(uid)` path both keep full access — the
  operator experience is unchanged.
- The `?s=` reviewer flow is unchanged (guest tokens carry no email claim; the
  `hasEmail()` guard routes them straight to `isShareGuest`).
- Client/`client_admin` gates are now *live* but inert until you provision users.

## Step 2 — Backfill `clientId` (dry-run, review, then apply)
```bash
node scripts/admin.mjs backfill --key sa.json                 # dry-run: prints the
                                                              # name → clientId map
```
Review the proposed `client` name → `clientId` slug map. If any names collide on a
slug, or you want specific slugs (`cadden`, `omni-nde`, `the-bdr`), supply overrides:
```bash
# map.json  →  { "OMNI NDE": "omni-nde", "The BDR": "the-bdr" }
node scripts/admin.mjs backfill --key sa.json --map map.json          # re-review
node scripts/admin.mjs backfill --key sa.json --map map.json --apply  # write it
```
Only ordinary posts/clients **missing** `clientId` are written (idempotent; safe
to re-run). `source: suggestion` rows are explicitly excluded: their `clientId`
must stay empty until the transactional promotion path resets their review
lifecycle. A non-empty/non-string suggestion tenant or malformed source is a hard
stop, including in dry-run. Every applied repair is guarded by the inventoried
Firestore `updateTime`; a conflict requires a fresh inventory. Posts with no
`client` field are skipped and reported — they can't be mapped.

## Step 3 — Audit (must be clean before any client login)
```bash
node scripts/admin.mjs audit --key sa.json --roster /secure/path/clients.json
```
Exits non-zero and lists offenders if any:
- **legacy post/automation/share IDs that do not match the hardened route
  formats** — stop the Worker rollout and migrate/re-issue deliberately.
- **ordinary posts without/carrying an off-roster `clientId`** — invisible to or
  misrouted for client users. Fix the source mapping, then re-backfill/restamp.
- **suggestions without canonical `forClientId`, exact empty `clientId`, owner
  uid, and `reviewStage: private`** — stop; never repair these by making them
  tenant-readable.
- **posts with missing, non-string, or wrong `uid`** — reported separately; a
  share token (which pins `shareOwner == post.uid`) would miss these.
- **clients docs without `clientId`** — branding unreadable by client users.
- **clients docs with missing, non-string, or wrong `uid`** — owner/guest
  branding reads are invalid.
- **one client name → multiple IDs or one ID → multiple names** — a tenant split;
  all resource claims are checked against the same canonical roster snapshot.
- **posts without `reviewStage: private|in_review`** — hidden by the current
  strict client/guest rules; run the guarded review-stage procedure first.
- **posts without canonical ISO-millisecond `updatedAt`** — omitted by the
  newest-first ordered query; the guarded stage/order backfill repairs only
  missing values from Firestore `updateTime` and refuses explicit malformed
  values.
- **posts with malformed explicit publication slugs** — the drafts API and
  strict broker fail closed rather than inventing an approval-bearing path.

## Step 4 — Provision client users (super_admin only)
Once the audit is clean *and* the app + Worker + rules are deployed, either use the
in-app **Manage Users** screen (sidebar → Admin, operator only) or the CLI:
```bash
node scripts/admin.mjs grant --email someone@client.com --role client       --client-id cadden --key sa.json
node scripts/admin.mjs grant --email lead@client.com    --role client_admin  --client-id cadden --key sa.json
```
`client-id` must match the slug the backfill assigned (see the audit output).
(A future entity-scoped `client_admin` self-invite — Sender's guard clauses — is
designed-for but not wired.)

## Step 5 — Re-issue links + harden
- **Re-issue ALL `?s=` review links.** The `clientId` re-key means any link minted
  before this deploy carries no `shareClientId` claim and now fails closed. Create
  fresh links from the Share Manager (operator: any client; client member: their own).
- **Disable Firebase Anonymous sign-in** (console → Authentication → Sign-in method) —
  the new model never needs it; legacy `?uid=` anonymous links are fully retired.

## Rollback
Re-deploying the previous `firestore.rules` restores prior behavior. The backfill
is additive (`clientId` only) and non-destructive — it never needs reverting; an
extra `clientId` field is harmless under the old rules.

## Known gap to automate (not blocking this phase)
`.github/workflows/deploy.yml` deploys the Worker + SPA on push to `main` but has
**no** `firestore:rules` step — rules are manual (`firebase deploy`). For the app/
Worker phase, add a `firebase-tools` step (gated on a `FIREBASE_TOKEN` /
service-account secret) as a coordinated migration. The current boundary
requires data/index gates first, then the frozen broker → POM → Spool sequence,
then rules and verification; do not blindly put a rules step before the
companion apps (see `REVIEW_STAGE_ROLLOUT.md`).
