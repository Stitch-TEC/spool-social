# Review-stage security rollout

`reviewStage` is now a Firestore authorization boundary. Guests and client
members may read, update, or delete a post only when its stored value is exactly
`in_review`; `private`, missing, and invalid values fail closed. The SPA's guest
and member listeners carry the matching `reviewStage == in_review` query.

This change needs one separately approved production data step. This PR does
not run it, deploy code, or deploy rules.

## Required sequence (do not reorder)

1. **While the old SPA and old rules are still live**, obtain a fresh service
   account key outside the repository. Export one fresh canonical broker
   `GET /clients` response to `/secure/path/clients.json`, inspect it, and use
   that exact immutable snapshot for every roster-aware gate in this rollout:

   ```bash
   node scripts/admin.mjs id-inventory --key /secure/path/sa.json
   node scripts/admin.mjs review-stage --key /secure/path/sa.json --roster /secure/path/clients.json
   node scripts/admin.mjs review-stage --key /secure/path/sa.json --roster /secure/path/clients.json --apply
   node scripts/admin.mjs audit --key /secure/path/sa.json --roster /secure/path/clients.json
   ```

   `id-inventory` is a hard compatibility gate for the new Worker boundary: all
   post and automation document IDs must be 20-character Firestore auto-IDs,
   and all share IDs must be 64 lowercase hex characters. If it reports a
   legacy custom ID, stop and deliberately migrate that document or re-issue
   the share; do not merge the strict validator and do not guess a mapping.
   Collection reads are fail-closed: an auth/API/list failure for posts,
   automations, shares, or client-branding docs terminates the gate and must not
   be interpreted as an empty collection. Firestore's exact successful empty
   ListDocuments response `{}` is accepted; a non-empty response with missing,
   scalar, or malformed `documents`, a bad document/updateTime, invalid JSON, or
   a repeated page token is not empty and stops the rollout.

   Review the stage dry-run count first. The apply command sets a missing stage
   on an ordinary legacy post to `in_review`, preserving its historical meaning;
   a missing-stage `source: suggestion` is set to `private` and its empty
   `clientId` is never filled. Every write uses the document's Firestore
   `updateTime`; a concurrent change aborts instead of receiving an unguarded
   merge. An explicitly tenant-readable suggestion or any invalid stage is a
   stop condition, never guessed or overwritten. The post-write audit must
   report zero missing/invalid stages. It also verifies every ordinary post,
   suggestion provenance (`forClientId`), client-branding doc, automation, and
   share tenant claim against the same canonical roster; verifies string
   ownership; and rejects ID/name splits in either direction.

   If the audit identifies a legacy missing/off-roster tenant claim, run the
   corresponding `backfill` or roster-backed `restamp` in dry-run first, review
   every mapping, then apply and rerun the full audit. Both commands classify
   suggestions separately, refuse any suggestion with a non-empty/non-string
   `clientId`, reject collisions in the legacy slugified-name repair map, and
   attach the inventoried document `updateTime` to every repair. Restamp covers
   ordinary posts, suggestion `forClientId`, branding, automations, and shares.
   A conflict is a stop/re-inventory event, never permission to retry a stale
   unguarded patch.

2. **Before the Spool application merge, update every internal PATCH caller**
   (currently the feedback-worker/POM review path; no automation PATCH caller
   was found in the suite inventory) to
   GET/list the draft, retain its `clientId`, `payloadRevision`, and
   `reviewRevision`, and echo them as `baseClientId`, `basePayloadRevision`, and
   (for review actions) `baseReviewRevision`. Deploy that caller change first;
   the old Spool Worker safely ignores these additive request fields. Confirm no
   blind PATCH caller remains. The hardened Worker returns `428` without a
   baseline and `409` on tenant/content/review drift, so skipping this step would
   make POM review actions unavailable after Spool deploy.
   Re-check ad hoc scripts during rollout, but do not describe automation as a
   caller unless one is actually found. Callers must also split editing from
   review intent: save content/title/platform/image/
   tag/schedule changes first, refetch the new revisions, then send, hold,
   approve, request changes, or resubmit in a separate PATCH. A mixed request is
   rejected with `400 mixed_review_edit` so nobody reviews bytes they did not
   baseline.

3. **Only after that audit and caller compatibility gate are clean, merge the application PR.** The Worker/SPA
   auto-deploys. Confirm an operator still sees private posts and current guest
   and member sessions see only in-review posts. The old rules still permit old
   query shapes during this short window, so review actions keep working, but
   the private-stage security fix is still inactive for cached/old clients.

4. **Immediately deploy the rules manually:**

   ```bash
   firebase deploy --only firestore:rules --project spool-social
   ```

   Smoke-test a current share link and a member login: list/approve/request
   changes on an in-review post; verify a private post cannot be read, changed,
   or deleted. Confirm prior feedback remains append-only.

5. Ask internal testers with an old cached SPA to reload. Once strict rules are
   live, an old client query without the stage constraint fails closed with
   `permission-denied`; it cannot leak private posts, but it will appear empty
   until the new app loads.

## Failure handling

- If dry-run reports explicit invalid values, stop and inspect them. Do not map
  them automatically.
- If ID inventory reports an incompatible post, automation, or share ID, stop
  before backfill/merge. Preserve the document, plan an explicit ID migration,
  and re-run the inventory; strict routes intentionally refuse legacy shapes.
- If any inventory/list operation fails, or ownership/clientId claims are
  missing, non-string, wrong-owner, malformed, off-roster, or ambiguous, stop.
  A JSON decode error or missing/malformed Firestore `documents` response is a
  failed inventory, not an empty collection. Repair or explicitly
  migrate the named rows, then rerun the entire gate; never waive unknown state.
- If any existing drafts API caller cannot supply the new baseline fields, stop
  before merging Spool. Do not weaken the Worker to synthesize a caller baseline
  from a just-in-time server read; that would not bind the action to the content
  and tenant the human/caller actually saw.
- If a suggestion has a non-empty `clientId`, a non-private explicit stage, an
  invalid/off-roster `forClientId`, or the wrong owner, stop. Do not run the
  ordinary post backfill over it and do not make it tenant-readable as a repair.
- If apply hits an update-time conflict, no rules should be deployed. Re-run the
  dry-run and apply after reviewing the concurrent edit. Earlier guarded writes
  in that run may already be present; the command is additive and safe to rerun.
- If the app deploys before the backfill, legacy rows disappear from client
  queries but remain operator-visible. Finish the guarded backfill before rules.
- Rolling rules back restores availability for old clients but reopens access
  to private tenant content. Record that as an active security regression, not
  a completed rollback.
