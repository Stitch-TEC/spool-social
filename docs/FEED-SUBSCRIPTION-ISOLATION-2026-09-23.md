# Spool feed subscription ownership — September 23, 2026

## Scope

This is an in-memory feed correctness fix, not a Firestore rules, authorization,
query, storage, pagination, or billing change. It accompanies the separately
documented interrupted-save guidance improvements. Release status belongs to the
suite release record, not this source note.

## Reproduced before the change

The real `usePosts` hook was run with entirely synthetic listener callbacks:

- Loading Alpha, then a null-auth interval, then Beta left Alpha posts and
  branding in the hook before **and after** Beta's first snapshot. Loading was
  already false while Beta was still waiting. The old listener had unsubscribed.
- After a retryable failure, a fresh listener's initial snapshot was merged into
  the old list. A post deleted during the gap remained visible, while the error
  cleared and the hook reported healthy updates.

Firestore reports initial documents as `added`; it does not report removals from
an earlier, separate listener. Incremental changes are valid only within one
listener attempt. These are synthetic reproductions, not established incidents
in actual client data. Explicit local sign-out already reloads the app, but that
does not protect cross-tab/session callbacks or reconnects.

## Updated contract

- Snapshot state owns its principal UID, Firebase User object, immutable client
  and share scope, operator flag, existing auth revision, and subscription
  permission. A conditional render-time ownership reset and returned-data fence
  prevent old data or errors appearing under a new owner—even for one render.
- `App` passes the existing `authRevision`, `getAuthRevision` and `authLoading`
  values. No new authentication API or authority is introduced. Signed-out or
  unresolved users cannot subscribe. The synchronous revision getter also
  rejects callbacks before React has committed new auth props.
- An attempt's first posts snapshot **replaces membership**, including an empty
  result. Later snapshots remain incremental and preserve unchanged post and
  Date references. A same-scope retry may show the previous feed with its real
  connection warning until that new initial snapshot arrives.
- Branding is tracked by document ID within the attempt, then projected into the
  existing name-keyed map. Replacement, removal and rename no longer retain an
  old name or a document absent from a new initial result.
- Cleanup invalidates both callbacks and cancels the retry timer. Terminated
  posts callbacks cannot turn a late response into a successful recovery.
- Explicit `permission-denied` or `unauthenticated` from either listener clears
  **both** data sets and reports a terminal stopped-updates error. The other
  listener cannot repopulate that attempt. A queued retry cannot reopen the same
  denied scope. A new authenticated scope/session or normal reload is required.
- Retryable errors retain the existing capped exponential retry policy. There is
  no new background retry, write, automatic recovery submission or cache clear.

## Verification

Focused tests cover the two original failures, first-render fencing, null user,
blocked/unresolved guests, unresolved auth, UID/client/role/share changes,
same-UID User replacement, revision ABA, A→B→A with no B snapshot, late callbacks,
empty retry results, branding rename/removal, exact query constraints, stable
incremental identities, terminal denials, queued retry/denial races, retry limits,
timer cancellation, unmount and StrictMode. The preceding scheduled-date
compatibility test remains in place with a stable synthetic Firebase User object.

The suite's stage record carries final test totals, independent review, source
identity and release proof. No tenant content or authenticated production call is
used in these tests.

## Unchanged limits and rollback

The initial workspace subscription remains unbounded. Grid windowing limits
rendered cards, not Firestore reads or content normalization. No performance gain
is claimed for this change. A transient branding-only failure retains the prior
logging behavior unless it explicitly denies authorization.

This patch does not erase IndexedDB recovery records, local storage, Firestore
persistence or remote data. It adds no offline or lifetime exactly-once promise.
Rollback is a reviewed source revert and ordinary frontend release; do not roll
back the independent interrupted-create safety floor or clear browser storage.
