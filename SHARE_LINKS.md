# Client review links (tokenized sharing)

How Spool shares content with clients for review, and how to deploy the change
safely.

## What changed

**Before:** a review link was `?uid=<owner>&client=<name>`. Anyone who opened it
signed in anonymously, and Firestore rules allowed *any* signed-in session to
read posts. A leaked workspace `uid` (or a guessed client name) effectively
exposed that client's content.

**Now:** a review link is `?s=<token>` where `<token>` is an unguessable,
per-`(owner, client)` secret. Opening it:

1. The app calls `POST /api/share/session` with the token.
2. The Worker looks up `shares/<token>` (via the service account) and mints a
   **Firebase custom token** carrying claims `{ share: true, shareOwner, shareClient }`.
3. The guest signs in with that custom token and can read **only** that one
   owner+client's posts — enforced by `firestore.rules`, not just the UI.

Guests may **only** approve, request changes, and append feedback. They cannot
edit content, delete, reassign a post, read other clients, or call the paid
generation / media / drafts APIs.

## Using it (owner)

- Header **Share** button → **Share Manager**.
- Pick a client → **Create a review link** (auto-copies). Send it to the client.
- Revoke any link instantly from the same panel; the token stops working at once.

## Using it (client/reviewer)

- Open the link — no account needed. See a progress bar ("5 of 8 approved").
- **Approve** or **Request changes** on each card; feedback is kept as a thread
  across review rounds.

## Deploying this change ⚠️

The Worker + SPA **auto-deploy on push to `main`** (`.github/workflows/deploy.yml`),
but **Firestore rules deploy manually** (`firebase deploy --only firestore:rules`).
That asymmetry creates a short window you must manage.

> **Mind the gap.** Once the new app is live but the *old* rules are still active,
> guest **reads** work (old read rule = any signed-in user) but guest **writes**
> (approve / request changes) are **rejected** — the new app sends `updatedAt` +
> `feedbackThread`, which the old guest-update allowlist (`status`,
> `approvalStatus`, `feedback`) forbids. So reviewers can *view but not act* until
> the rules are deployed. The owner dashboard is unaffected throughout.

**Recommended sequence (minimizes disruption):**

1. **Merge to `main`** → CI deploys the Worker (share endpoints) + SPA
   (`?s=` flow + Share Manager). Don't hand out any links yet.
2. **Immediately deploy the new rules** (don't leave the gap open):
   ```bash
   firebase deploy --only firestore:rules   # verify in the Rules Playground first
   ```
   After this: `?s=` links work fully (read + write); old `?uid=` anonymous links
   **stop working** (no `share` claim → reads denied).
3. **Now create + distribute `?s=` links** from the Share Manager and re-issue them
   to clients who had old `?uid=` links.
4. **(Recommended) Disable Firebase Anonymous sign-in** (Firebase console →
   Authentication → Sign-in method). Guests use custom tokens now, so disabling
   anonymous auth closes the last path to obtaining *any* session.

> **Why app-first, not rules-first?** Deploying the rules *before* the app is worse:
> the new read rule would immediately break existing `?uid=` reviewers **and** the
> Share Manager (the only way to mint `?s=` links) wouldn't exist yet — leaving a
> window with *no* working review path at all.

**Best fix (eliminates the gap):** automate the rules deploy in CI so it runs with
the Worker deploy. Add a `firebase-tools` step gated on a `FIREBASE_TOKEN` (or
service-account) secret to `deploy.yml`, ordered before the Worker publish. Until
that's wired up, follow the manual sequence above and keep step 1→2 tight.

### Rollback

Re-deploying the previous `firestore.rules` restores the old behavior. The
Worker/SPA changes read fine under the old rules (only guest *writes* differ), so
they don't need reverting — but guest review actions will fail until the new rules
are back.

## Data model

- `shares/<token>` (Worker-only; `firestore.rules` denies all client access):
  `{ ownerUid, client, label, revoked, createdAt }`.
- `posts.feedbackThread`: `[{ text, by: 'client'|'you', at }]` — review history
  (the legacy single `feedback` field still holds the latest note).

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/share/session` | none (token in body) | exchange token → guest custom token |
| POST | `/api/share` | owner Firebase token | create a link `{ client, label }` |
| GET | `/api/share[?client=]` | owner Firebase token | list the owner's links |
| DELETE | `/api/share/:token` | owner Firebase token | revoke a link |
