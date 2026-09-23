# Editor save lifecycle — September 22, 2026 (Phoenix)

## What changes

A slow save previously closed the editor even when someone had typed newer work,
or had closed it and opened another draft. The create path also discarded the
new Firestore ID, so merely retaining a new form would create another document
on its next save.

- App returns the acknowledged document ID and committed baseline; the editor
  that initiated the save decides whether to close.
- Fields changed after submission remain in the editor. Unchanged fields adopt
  the actual stored values, including hosted media, concurrent workflow changes
  and same-client display-name updates. An explicit message explains that the
  newer work needs another save.
- A retained new draft updates its acknowledged ID on the next save, even before
  the posts subscription catches up. Its recovery slot moves from `new` (or
  `new-template`) to that ID; page-hide snapshots follow the new slot.
- Closed editors ignore late completions. A pending grid duplication also cannot
  close an unrelated editor. Pending saves keep the existing Close/discard exit.
- An immediate submission lock prevents repeated saves. Synchronous form mirrors
  retain edits queued in the same rendering batch as a save response. Client-name
  refreshes cannot reload the original post over the current editing session.

The existing Firestore transaction remains the write authority. Tenant-change
denials, same-ID rename handling, review/approval resets and explicit payload
mapping are unchanged. The new transaction result is the live record plus the
actual committed patch, not a stale copy of what the form requested.

## Verification and release boundary

Regression coverage uses real App, Editor and transaction code with synthetic
subscriptions and Firebase transport. It covers acknowledged create→update with
a deliberately stale subscription, same-batch typing, late create/update success
and rejection after switching editors, and delayed duplication. Editor and pure
helper tests cover every work field, recovery-key migration, failure retry,
committed status/client/media adoption and client-name refreshes.

Run the full unit suite, Firestore rules emulator, lint, build, action-pin and
dependency gates before release; independently review source and actual-component
Chromium/WebKit behavior. Exact outcomes and deployment identities belong in the
suite release evidence and status after those checks complete.

No rule, schema, worker route, billing, Google integration, email delivery or
automatic publishing change is included. All persistence fixtures are invented;
public production smoke checks are not signed-in acceptance tests.

## Limits

This is not a new offline queue or crash-safe create-idempotency system. A create
whose acknowledgement never reaches its still-open editor (for example after
closing it or crashing) retains the prior recovery behavior; reopening an old
unsaved snapshot must not be described as guaranteed duplicate-free. Local
recovery remains device storage, may fail, and omits oversized data-URL images.
It does not replace server backup or a deliberate Save.

Rollback, if needed after fresh verification, is a code-only release of the
previous version. Do not roll back or delete documents to undo this UI change.
