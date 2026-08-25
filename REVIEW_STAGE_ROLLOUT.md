# Review-stage security rollout

`reviewStage` is now a Firestore authorization boundary. Guests and client
members may read, update, or delete a post only when its stored value is exactly
`in_review`; `private`, missing, and invalid values fail closed. The SPA's guest
and member listeners carry the matching `reviewStage == in_review` query.

This change needs separately approved production data, index, deploy, rules,
and cache-verification steps. This PR performs none of those live actions.

## Required sequence (do not reorder)

This rollout uses a short internal maintenance window. Announce the freeze and
perform **no send/hold/approve/request-changes/resubmit actions from the first
companion deploy until the post-rules smoke tests pass**. Draft editing can also
wait; this keeps a human approval from racing the three-service contract change.

Before the window, synchronize the release-manifest blocks in PRs #10/#50/#100.
For every repository record the up-to-date head commit, head tree OID, and base
OID after final tests/review. Use merge-commit only—never squash, rebase-merge,
auto-update, or make conflict edits after review. Immediately after each merge,
record the resulting `main` OID and prove its tree equals the reviewed head tree;
for each auto-deploy, require the successful GitHub Actions deployment run whose
event SHA is that exact `main` OID and record both the run URL/ID and downstream
provider deployment/version ID. If POM's exact-OID run reports that its Hosting
version was already active, record that no-op log evidence and the still-active
version rather than expecting a new release ID. The providers do not expose a
trustworthy runtime Git SHA, so the merge-tree proof plus OID-keyed run is the
source chain of custody. A different tree, run OID, or deployment is a
stop/rollback event. Current pre-rebase candidate hashes are not deployable.

From manifest verification until the review freeze is lifted, allow no unrelated
push, merge, manual deployment, or `workflow_dispatch` run in broker, POM, or
Spool. Immediately before advancing each boundary and again before lifting the
freeze, prove each recorded provider deployment/version is still active. A
superseding deployment invalidates the smoke result and stops the rollout.

1. **While the old SPA and old rules are still live, prepare the data and
   indexes.** Obtain a fresh service-account key outside the repository. Export
   one fresh canonical broker `GET /clients` response to
   `/secure/path/clients.json`, inspect it, and use that exact immutable snapshot
   for every roster-aware gate:

   ```bash
   node scripts/admin.mjs id-inventory --key /secure/path/sa.json
   node scripts/admin.mjs review-stage --key /secure/path/sa.json --roster /secure/path/clients.json
   node scripts/admin.mjs review-stage --key /secure/path/sa.json --roster /secure/path/clients.json --apply
   node scripts/admin.mjs audit --key /secure/path/sa.json --roster /secure/path/clients.json
   firebase deploy --only firestore:indexes --project spool-social
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

   Review the stage/order dry-run count first. The apply command sets a missing stage
   on an ordinary legacy post to `in_review`, preserving its historical meaning;
   a missing-stage `source: suggestion` is set to `private` and its empty
   `clientId` is never filled. The same command fills a missing `updatedAt` from
   that document's normalized Firestore `updateTime`; an explicit malformed
   `updatedAt` is never guessed. Stage and timestamp changes for one row are one
   update-time-preconditioned PATCH, so a concurrent change aborts rather than
   receiving an unguarded merge. An explicitly tenant-readable suggestion or
   any invalid stage/timestamp is a stop condition. The post-write audit must
   report zero missing/invalid stage and ordering values. It also verifies every ordinary post,
   suggestion provenance (`forClientId`), client-branding doc, automation, and
   share tenant claim against the same canonical roster; verifies string
   ownership; rejects ID/name splits in either direction; and flags malformed
   publication slugs. Wait until the new `posts(uid ASC, updatedAt DESC)` index
   is **READY**, not merely submitted, before starting the maintenance window.
   The list query orders by `updatedAt DESC, __name__ DESC`; its snapshot cursor
   also carries both values plus the number already seen, so missing order keys,
   duplicates, and gaps fail closed.

   If the audit identifies a legacy missing/off-roster tenant claim, run the
   corresponding `backfill` or roster-backed `restamp` in dry-run first, review
   every mapping, then apply and rerun the full audit. Both commands classify
   suggestions separately, refuse any suggestion with a non-empty/non-string
   `clientId`, reject collisions in the legacy slugified-name repair map, and
   attach the inventoried document `updateTime` to every repair. Restamp covers
   ordinary posts, suggestion `forClientId`, branding, automations, and shares.
   A conflict is a stop/re-inventory event, never permission to retry a stale
   unguarded patch.

2. **Start the freeze, then deploy feedback-worker first.** Its Spool broker must
   close the private-row path, forward the opaque list cursor instead of scanning
   an arbitrary whole collection, and bind the full POM preview contract:
   `platform`, `title`, `content`, canonical `imageUrl`, `altText`,
   `metaDescription`, and effective publication `slug`. It must retain and echo
   `clientId`, `payloadRevision`, and (for review actions) `reviewRevision`.
   Temporary failure of the old POM Content card is accepted and preferred to a
   private-row leak or invented optional value. Confirm no POM, feedback-worker,
   automation, or ad-hoc PATCH caller remains blind.

3. **Deploy POM second.** POM must render and acknowledge the same seven preview
   fields, preserve the opaque revisions, request `reviewStage=in_review`, page
   with `nextCursor`, and split edits from review actions. A platform/title/
   content/image/alt/meta/slug edit is saved first; POM refetches the returned
   revisions before a separate review PATCH. Tags are internal and do not change
   approval identity. `scheduledDate` is workflow-only: it does not revoke an
   approval, but it is part of `reviewRevision`, so a schedule race returns 409.
   Archived rows are not actionable.

4. **Merge/deploy the final Spool PR third using merge-commit only.** Worker/SPA
   auto-deploys from `main`. Record the merge OID, prove its tree equals the
   manifested Spool head tree, require the successful GitHub Actions deployment
   run whose event SHA is that exact OID, and record its run URL/ID plus the
   Cloudflare deployment/version ID. Prove that exact version is active before
   proceeding. Its list/get output normalizes legacy missing preview fields to
   explicit strings and derives a missing long-form publication slug from the
   same bound title/content fallback the publisher uses. The full serialized
   list envelope—including normalized rows, both revisions, totals, and cursor—
   is capped at 1 MiB. A single row that cannot fit fails closed with
   `draft_row_too_large`; repair/quarantine it rather than skipping it. Stable
   failures are `{error:<symbolic_code>,message}` for
   `review_baseline_required`, `review_conflict`, `mixed_review_edit`,
   `feedback_invalid`, `feedback_thread_full`, `feedback_thread_invalid`, and
   `draft_cursor_invalid`. Do not end the freeze yet.

5. **Immediately deploy the rules manually from a separate clean checkout.** Set
   the two recorded OIDs and choose a new operator-approved absolute worktree path;
   do not use the ordinary Spool checkout. Prove both the full tree and the rules
   blob before running Firebase:

   ```bash
   set -euo pipefail
   SPOOL_RELEASE_OID=RECORD_THE_SPOOL_MAIN_MERGE_OID
   SPOOL_REVIEWED_TREE_OID=RECORD_THE_MANIFESTED_SPOOL_TREE_OID
   SPOOL_RULES_CHECKOUT=/absolute/operator-approved/spool-rules-checkout
   git fetch origin main
   test "$(git rev-parse origin/main)" = "$SPOOL_RELEASE_OID"
   git worktree add --detach "$SPOOL_RULES_CHECKOUT" "$SPOOL_RELEASE_OID"
   cd "$SPOOL_RULES_CHECKOUT"
   test -z "$(git status --porcelain --untracked-files=all)"
   test "$(git rev-parse 'HEAD^{tree}')" = "$SPOOL_REVIEWED_TREE_OID"
   test "$(git hash-object firestore.rules)" = "$(git rev-parse HEAD:firestore.rules)"
   firebase deploy --only firestore:rules --project spool-social
   ```

   Record the Firebase rules release/deployment result. Any failed equality test,
   dirty status, wrong checkout, or mismatched rules blob stops the rollout.

6. **Run contract and authorization smoke tests before lifting the freeze.**
   Confirm the operator sees private posts; old POM/guest/member query shapes fail
   closed; current POM, guest, and member views show only exact `in_review` rows;
   private rows cannot be read/changed/deleted; and an archived in-review row
   cannot be approved. On a disposable in-review draft, approve and request
   changes, verify feedback text is stored exactly and history remains
   append-only, then change each of platform/title/content/image/alt/meta/slug
   and verify approval resets and a stale baseline returns `409 review_conflict`.
   Change only tags (approval remains) and race a schedule
   change (review action conflicts). Exercise `nextCursor` across equal
   timestamps and confirm newest-first order with no duplicate/gap.

   Ask internal testers with an old cached SPA to reload. Once strict rules are
   live, an old client query without the stage constraint fails closed with
   `permission-denied`; it cannot leak private posts, but it will appear empty
   until the new app loads.

7. **Only after the application/rules checks pass, perform the R2 inventory and
   both-host Cloudflare cache verification in `MEDIA_SECURITY_ROLLOUT.md`.** Do
   not delete or rewrite objects. Verify canonical v2 URLs, the exact legacy
   alias redirect, attachment handling for unsafe legacy objects, and both
   hostname cache surfaces. Immediately before lifting the freeze, re-check that
   the recorded broker, POM, and Spool provider versions are all still active and
   that no unrelated repository or deployment event occurred during the window.
   Then lift the maintenance freeze.

## Failure handling

- If dry-run reports explicit invalid values, stop and inspect them. Do not map
  them automatically.
- If the ordered-post index is not READY, stop before the maintenance window.
  Do not rely on a submitted/building index or remove newest-first ordering to
  make the query run.
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
- If any companion does not preserve all preview strings (platform, title,
  content, imageUrl, altText, metaDescription, effective slug), opaque
  revisions, stable error codes, or `nextCursor`, stop. The accepted temporary
  state is a fail-closed POM card, never a partial/invented approval preview.
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
