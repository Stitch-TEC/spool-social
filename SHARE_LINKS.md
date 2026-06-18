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

The Worker auto-deploys on push to `main` (`.github/workflows/deploy.yml`), but
**Firestore rules deploy manually**. Order matters:

1. **Merge to `main`** → CI builds + deploys the Worker (share endpoints) and the
   SPA (the `?s=` flow + Share Manager). At this point:
   - New `?s=` links work.
   - Old `?uid=` links **still work** (the app falls back to anonymous sign-in,
     which the *old* rules still permit). Nothing breaks yet.
2. **Deploy the new rules:**
   ```bash
   firebase deploy --only firestore:rules
   ```
   After this:
   - `?s=` links keep working (claim-scoped reads).
   - Old `?uid=` anonymous links **stop working** (no `share` claim → rules deny
     the read). Re-issue those clients a new link from the Share Manager.
   - The owner dashboard is unaffected throughout (owner reads via `isOwner`).
3. **(Recommended) Disable Firebase Anonymous sign-in** in the Firebase console
   (Authentication → Sign-in method). Guests now use custom tokens, so anonymous
   auth is no longer needed — disabling it closes the last path by which a random
   visitor could obtain *any* session.

### Rollback

Reverting the rules (`firebase deploy --only firestore:rules` from the previous
file) restores the old behavior. The Worker/SPA changes are backward compatible
with the old rules, so they don't need reverting.

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
