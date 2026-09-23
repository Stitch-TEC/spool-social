# Interrupted new-editor saves — September 23, 2026

Status: source candidate, pending independent frozen-source review and hosted checks. This is not a deployment record. Requester: platform owner. Priority/risk: medium; a bounded browser persistence change, not a server migration.

## Why and scope

Before this change, closing/reloading an ordinary new editor before its Firestore `addDoc` acknowledgement could leave an ID-less recovery copy. Restoring and saving it could create a second thread even though the first request had committed. This was the documented #117/#118 residual, not evidence of real client data damage.

Ordinary **New Thread / New Template** editors now retain a reserved document identity with their local work. Existing-post transactions, review/approval/tenant guards, grid duplication, imports, suggestions, repurposing, automation, Worker APIs, Firestore rules and dependency/configuration files remain unchanged. No background delivery is introduced.

The new browser IndexedDB database is `spool-create-recovery-v3`, store `intents`. Its exact key includes version, actual authenticated Firebase UID, project, default database, canonical client ID and thread/template flow. The post's shared operator `uid` is never the browser principal. A missing authoritative account/client/project blocks new creation rather than guessing a tenant from a label. Existing #118 localStorage copies are not read, adopted, removed or rewritten by this new-editor flow; existing-post editors keep their existing recovery behavior.

## Small state machine

| State | Meaning and allowed action |
| --- | --- |
| `draft` | Device-only work, reserved random ID; no request prepared. Edit/restore or explicitly discard this exact unsent revision. |
| `prepared` | First normalized create payload and submission snapshot frozen, including hosted image result and timestamps. Save can continue that recorded payload, never substitute newer work. |
| `submitted` | A browser transaction committed the may-have-dispatched marker before the only POST. Timeout, fetch failure, 403/404/409 or closing never resets this state or permits another create. |
| `confirmed` | An authorized exact-ID response matched the expected stored copy. Newer work stays separately revisioned and the existing transactional update path updates this ID. |
| `complete` | Acknowledged, no newer work at retirement. A late edit can reopen only this same ID/revision as confirmed; a replacement intent or another tab's revision produces a visible conflict instead. |
| `discarded` | Explicitly abandoned never-prepared draft. A fresh deliberate draft may reserve a new ID; stale tabs cannot revive the discarded copy. |

There is one current recovery slot per scope. Browser transactions serialize changes and compare both ID and work revision; an old tab never adopts a newer revision just to overwrite it. Conflicting local work stays in the editor for copying. Terminal markers are retained until a deliberate later draft replaces that exact slot; no blanket browser-storage cleanup is performed.

Each edit queues a local transaction, not just an unload handler. Initial preparation and submission admission wait for transaction **completion**, not an individual successful `put`. Blocked/open/transaction failure is bounded to five seconds and fails before any new dispatch. Normal browser commit still does not guarantee survival of power loss, device loss, storage eviction, private-mode restrictions, or clearing website data. Unload may end before its asynchronous flush finishes. The UI only says a recovery copy is current after the actual transaction completed; Copy text remains available (images/settings are not copied).

## Remote boundary and reconciliation

The narrow browser transport uses a Firebase **ID token**, not an Admin SDK or Worker credential, with Firestore REST `createDocument?documentId=<reserved-id>`. The unchanged Firestore rules apply. Current user object, synchronous auth-session revision and editor lifetime are checked around image preparation, token lookup, journal admission and response handling. A same-UID sign-out/sign-in is a new session. Tokens never enter the journal.

**Check previous save is read-only:** it requests only the reserved ID. Identity and the full expected payload/baseline must match before the editor adopts that ID. It never retries POST, invokes `setDoc`, generates a replacement ID, uses content similarity to deduplicate, or trusts a cached listener result as proof. Newer work is reconciled field-by-field with the acknowledged baseline, including normalized media/schedule values. Another explicit Save uses the existing transaction and its live approval/client guards.

An absent/inaccessible/changed/deleted result remains unresolved, because there is no immutable server receipt or tombstone proving whether a past request committed. The operator must review the existing thread and preserve/copy local work. This is deliberately **not** automatic retry, offline sync, universal exactly-once delivery or automatic deduplication. Freeing uncertain identities, remote resurrection and lifetime idempotency need a separately designed server receipt policy.

Client and template-flow selection are fixed once preparation begins and throughout that editor's recovery session. Reopen the acknowledged existing thread for a deliberate guarded client reassignment. A pure client-label rename does not change the recovery key. Unknown legacy v2 copies require manual inspection/copy by their owner; they cannot be offered as verified interrupted-create retries. Cached older app versions can still use their old `addDoc` path until reloaded.

## Acceptance and limits

- Actual App → Editor tests cover lost acknowledgement/remount, same reserved-ID updates, newer typing, delayed retirement, late closed completions, account isolation, same-object auth ABA, member staging, unchanged suggestion/grid behavior, exact v2 preservation, failed transaction admission and never-dispatched empty-draft abandonment.
- Journal tests cover scope, frozen payload, work revisions, concurrent admission/CAS, rollback after put, quota/blocked/open errors, corruption and safe terminal transitions. Their small deterministic transaction fixture is **not** native storage-engine proof.
- Real Chromium/WebKit QA uses native IndexedDB and the actual Editor/transport with invented data and intercepted requests; root retains evidence under `_archive-2026-09/spool-create-recovery-20260923/`.
- Local emulator tests run the actual transport against unchanged Firestore rules: owner-private/member-in-review create/read, duplicate-create conflict, foreign/private/unknown-member denial and changed/deleted read-only checks. They never connect to production.
- Local acceptance: **625 application tests and 34 unchanged-rule emulator cases**, lint, build, action pins and zero production dependency findings pass. Hosted checks and independent review are separate release gates. No physical iPhone/Home Screen resume, production content write or live authenticated create is claimed.

This does not make image upload side effects idempotent or expand recovery to other create lanes. A failing final image/journal operation keeps the editor available. Work cannot be guaranteed recoverable when browser storage does not work; there is no silent fallback to non-idempotent `addDoc` for this lane.

## Rollout, support and rollback

1. Source author runs local acceptance; independent reviewers exercise exact frozen source and native browsers. Root reviews the final tree and hosted checks before any release.
2. After approved merge, verify automatic Worker release, unchanged runtime/bindings/secret-name metadata, exact built app/lazy Editor assets, health and anonymous access denial. No rules, migration, provider, credential or email operation is part of this release.
3. Tell the operator to reload Spool. On uncertainty: keep the tab, restore the recorded work, use Check previous save, then explicitly Save newer edits only once the same ID is confirmed. If recovery cannot be read, Copy text and ask for review instead of repeatedly creating a new thread. Monthly reporting and client invitations are unaffected.
4. Roll back on a verified new startup/editor-blocking regression to the preceding #118 web artifact, with root's normal release checks. **Do not clear `spool-create-recovery-v3`, convert its pending entries into v2/new drafts, or assume old code can reconcile them.** Keep those devices' uncertain saves held/copy-only until a reviewed fix-forward can read v3. No server schema or rules rollback is needed. Reverting source restores the old create limitation, so do not advise blind retries in an old build.
5. Preserve the release/evidence record and any failed-case details without private content. Measure actual operator friction/recovery outcomes before expanding this to other create lanes; no telemetry provider or automatic report is activated.

Independent GO, exact-head checks and root release authorization are still required. The operator needs no new credential, vendor setting, database migration or subscription.
