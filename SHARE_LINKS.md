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
   **Firebase custom token** carrying claims `{ share: true, shareOwner,
   shareClientId, shareToken }`.
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

The rules also validate guest review values and transitions: approval/status
enums are bounded, only `draft → scheduled` may accompany a guest approval,
feedback is capped at 500 characters, and each feedback write must append one
client-attributed history entry without deleting prior entries. Approval and
feedback must also stamp `reviewedBy:"client"` plus one matching ISO
`reviewedAt`/`updatedAt` value. The SPA performs these actions in Firestore
transactions bound to the post's clientId, approved-payload identity, and review
state, so content/tenant/reviewer races return a visible conflict instead of a
last-write win. A code deploy
does not activate these rule changes; use the manual deploy/verification step
below after the application PR is merged.

Registered client members use the same review contract. Their separate
editorial path is limited to bounded post fields and safe status transitions;
new member posts must start `draft / pending / in_review`, and changing an
approved title/content/image/platform must reset approval to `pending` atomically.
Members cannot forge posted/approved creation state, review attribution, or
replace feedback history.

> **Mind the security gap.** The currently deployed rules already allow the
> fields the app writes, so approve/request-changes actions continue to work
> after the Worker/SPA deploy. They remain too permissive, however: the enum,
> transition, length, timestamp, and append-only checks above are **inactive**
> until the manual rules deploy succeeds. A green application deploy does not
> mean this security fix is live.

**Required sequence:**

1. Complete the strict legacy-ID inventory gate and guarded missing-`reviewStage`
   dry-run/apply/audit in
   [`REVIEW_STAGE_ROLLOUT.md`](REVIEW_STAGE_ROLLOUT.md) while old code/rules are live.
2. **Merge to `main`** → CI deploys the Worker + SPA. Existing review actions
   continue working under the old rules, but all rule security fixes remain inactive.
3. **Immediately deploy the new rules** (keep the permissive window short):
   ```bash
   firebase deploy --only firestore:rules   # verify in the Rules Playground first
   ```
4. **Smoke-test both actions** with a current `?s=` link: approve a draft and
   request changes on another. Confirm the workflow status is not rewound for a
   posted/archived thread and prior feedback remains present.

**Future improvement:** automate a coordinated application-then-rules rollout in
CI, with a Firebase credential that can deploy rules and a post-deploy review
smoke test. Do not simply put this stricter ruleset before the application deploy:
the prior SPA lacks the stage-constrained query and does not guarantee the new
feedback-entry timestamp invariant. A
truly zero-window rollout needs an explicitly backward-compatible intermediate
rules/app version; until then, follow the manual sequence above and keep step
1→2 tight.

### Rollback

Re-deploying the previous `firestore.rules` restores the permissive behavior.
Guest review actions continue working, but the security gap reopens; record that
state explicitly rather than treating rollback as a completed remediation.

## Data model

- `shares/<token>` (Worker-only; guest rules only test existence/revocation):
  `{ ownerUid, client, clientId, label, revoked, createdAt }`.
- `posts.feedbackThread`: `[{ text, by: 'client'|'you', at }]` — review history
  (the legacy single `feedback` field still holds the latest note).

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/share/session` | none (token in body) | exchange token → guest custom token |
| POST | `/api/share` | owner Firebase token | create a link `{ client, label }` |
| GET | `/api/share[?client=]` | owner Firebase token | list the owner's links |
| DELETE | `/api/share/:token` | owner Firebase token | revoke a link |
