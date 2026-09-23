# Editor recovery and asynchronous-result boundaries

This bounded follow-up fixes the two synthetic findings in the September 23
Spool review: shared-browser recovery crossing accounts/clients, and late AI
results replacing work after a client/platform change or cancellation.

## Recovery policy

- New recovery entries use a v2 envelope and key containing the authenticated
  Firebase UID, immutable client slug, and post ID or separate new-thread /
  new-template slot. Read-time checks validate the embedded scope and field
  types. A display label alone is not a recovery identity.
- The operator's client must resolve through known roster/post/branding IDs;
  client members use their pinned client ID. Unknown user/client identity means
  no local recovery read or write until a recognized client is selected. Normal
  remote draft saving remains available; successful saving can supply the
  authoritative ID. Close/error messaging continues to describe actual local
  storage success, not promise unavailable recovery.
- Recovery only offers the current account/client's copy. A same-ID client
  rename retains the current display label when restoring older content.
- Acknowledged saves retire the submitted scoped new slot. Newer work remains
  in the editor under the acknowledged document ID; a later save updates that
  ID, including before the subscription refreshes. Changed-client newer edits
  migrate to their own scoped slot only after successful storage.
- App editor sessions are bound to the opening UID/role/tenant. A principal or
  authorization change unmounts the old editor, including cross-tab sign-out.
  Unmount flushes its latest dirty work to that old session's scoped local copy
  where storage is available, even inside the debounce window; no remote save.
  Authentication clears old authorization while resolving a new account and
  ignores out-of-order role lookups.

### Legacy copies are preserved, not automatically trusted

Old `spool:autosave:*` entries outside the v2 namespace do not identify their
owner. They are **left byte-for-byte in browser storage**, ignored by the app,
and never automatically migrated, adopted, displayed or deleted. There is no
global localStorage wipe or automatic sign-out deletion in this change.

If an operator needs an older copy, it requires a deliberate, local manual
recovery on the original device after confirming its owner and client. Do not
paste raw recovery data into shared chat, logs, tickets or another account's
editor; do not infer ownership from the current login or a mutable client name.
There is no self-service legacy-recovery tool in this release. Separately decide
whether to build a restricted recovery/export flow before deleting legacy work.

This is application-level isolation, not encryption against somebody with OS /
browser-storage access. Scoped data remains on that device until normal save /
dismiss cleanup or explicit browser-data removal. Old installed/offline builds
must reload to use the new behavior; this change does not remotely erase data.

## AI result policy

Generation requests carry a mounted-context generation token. Changing client
or platform, cancelling the panel, or unmounting invalidates old results,
including an A → B → A round trip. An old result/error/finalizer cannot replace
text/images or unlock a newer pending request. The guard covers Generate,
Improve, Hashtags, image generation, page-angle ideas, brainstorm, editor
meta/alt generation, and repurpose-to-social generation.
Channel changes also reset pending angle/brainstorm controls without refetching
unchanged client signals. Blog and Job share the repurpose panel; switching
between them retires pending generation and leaves the controls usable.

Repurpose cancellation stops subsequent generations and prevents its draft
write if generation is still pending. Cancellation does **not** claim to cancel
provider billing or undo a draft write already submitted. Existing private
staging, approval invalidation, tenant save guards and provider routing remain
unchanged. Same-context successful generation retains existing replacement /
Undo behavior.

## Verification and explicit limits

Actual App/Editor/auth tests cover account/role changes, stale role resolution,
foreign/legacy recovery exclusion, unknown identities, same-owner recovery,
client renames, late AI variants, cancellation and acknowledged-save identity
migration. The previous pending-save, newer-edit and late-close tests remain.
Synthetic Chromium/WebKit fixtures exercise the actual Editor under StrictMode
on phone/tablet widths, with invented accounts and intercepted generation.
No live content, provider call, email, billing change, rule deployment, database
schema or credential setting is part of this change.

Local Node 22.19 acceptance: **588 ordinary tests**, **30 unchanged rule-emulator
cases**, six Chromium/WebKit viewport runs, lint/build/action-pin checks, and
`npm audit --audit-level=high` (zero vulnerabilities) passed. The emulator tests
run separately; their 30 skips in the ordinary run are expected. Tests do not
claim signed-in production acceptance or a deployed release. Local replay and
screenshots are archived under the suite's
`_archive-2026-09/spool-bug-fixes-20260923/`.

Unacknowledged offline creates still have no crash-safe idempotency contract.
Storage denial/quota exhaustion can leave newer edits only in memory. Both are
existing limitations, not claimed fixed. Newer recovery is not a backup or a
substitute for an acknowledged remote save.
