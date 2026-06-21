# Spool RBAC — Deploy Runbook (Phase 1: data model + rules + backfill)

This is the **ordered** procedure for shipping the security boundary. Order is
load-bearing: several Firestore rules flip to `isSuperAdmin()`, which reads your
`users/{email}` doc — deploy the rules before that doc exists and **you lock
yourself out of provisioning.** Do the steps in sequence; don't skip the audit.

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

## Step 1 — Deploy the new rules
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
Only posts/clients **missing** `clientId` are written (idempotent; safe to re-run).
Posts with no `client` field are skipped and reported — they can't be mapped.

## Step 3 — Audit (must be clean before any client login)
```bash
node scripts/admin.mjs audit --key sa.json
```
Exits non-zero and lists offenders if any:
- **posts without `clientId`** — invisible to client users (operator-only via
  `isOwner`). Fix the source `client` value, then re-backfill.
- **posts with `uid != OWNER_UID`** — a share token (which pins `shareOwner ==
  post.uid`) would miss these; investigate.
- **clients docs without `clientId`** — branding unreadable by client users.
- **one client name → multiple clientIds** — a tenant split; resolve before logins.

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
service-account secret) ordered **before** the Worker publish, so rules and app
ship together (per `SHARE_LINKS.md`'s deploy-ordering hazard).
