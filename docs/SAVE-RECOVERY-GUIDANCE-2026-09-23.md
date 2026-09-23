# Save recovery guidance — September 23, 2026

Status: source candidate; independent frozen-source and release gates remain separate.

## Why

The interrupted-create safeguards correctly hold an uncertain identity, but “ask the operator
to review it” provided no exact reference. The generic unexpected new-save error also invited
“try again,” and Copy text could report into a later editor/session after its clipboard promise
finished. These are reproduced code/fixture findings, not evidence of a real content incident.

## Bounded change

- Prepared/submitted/confirmed recovery records have a collapsed **Help with this save** panel.
  It explains preservation, read-only checking and private support review. It cannot release,
  discard, adopt, retry, recreate or reconcile an identity.
- A selectable read-only **Save reference** contains only verified project/client ID, flow,
  reserved thread ID, device state/revision and normalized first-preparation time. A positive
  reference is not evidence that the latest edits reached the server. The helper validates the
  exact current scope and active principal before rendering/copying.
- Export is an explicit clipboard click. No title/body, tags, images/URLs, sign-in UID, token,
  journal key, arbitrary stored fields or raw error text are included. The reference still
  identifies a client/thread: share it privately, not in a public issue or social post.
- Clipboard denial/absence leaves a selectable reference with manual-copy guidance, never a
  success claim. Account/scope changes and unmount suppress stale completion notices. A copy
  already dispatched at an explicit click cannot be revoked or cleared by signing out.
- Existing **Copy text** means current editor text only, not stored work. It is disabled when
  empty (including before Restore), offers manual copying if needed, and checks live editor,
  authenticated session and scope before dispatch and before late success/error notices.
- Exact-ID reconciliation says **Checking…**, not Saving. The generic unexpected new-create
  exception asks users to follow recovery guidance rather than blindly retry. Existing-post
  error copy retains its separate contract.

The journal/storage schema, keys, scoped ownership, transport, Firebase token/rules checks,
create-only admission, revision guards and remote writes are unchanged. Checking is still an
explicit exact-ID GET. Inaccessible, deleted or changed targets remain unresolved. No automatic
email/support ticket/telemetry/export or new backend lookup was added.

## Acceptance and limitations

Unit/component cases exercise allowlisted output, malformed/foreign records, thread/template
labels, no automatic storage/network/clipboard action, unavailable clipboard, active-session
invalidation, scope/revision changes, unmount and native manual-copy controls. Actual App→Editor
cases preserve one-create/GET-only behavior after 403/404, verify checking labels, and exercise
current-text copying plus late completion after close/auth revision changes.

Native-browser, independent and hosted release evidence belongs in the suite's dated
`_archive-2026-09/spool-save-guidance-20260923/` record. Do not treat this source note as
physical-iPhone/VoiceOver acceptance or a production deployment record.

## Rollout and rollback

Run full ordinary checks, independent source/browser review and exact-head protected PR gates.
Verify reviewed/merged tree equality and public deployed assets/runtime metadata afterward.
No production save, approval, email, rules or database test is required.

Reload normally. If a save remains unresolved, preserve the device record, Copy text if useful,
and share its reference privately for a deliberate authorized review. This feature intentionally
does not unlock another create. A safe release/reset workflow still needs a server receipt policy.
If guidance or clipboard handling regresses, use a narrow reviewed fix-forward/revert; never
clear journal data or reset a submitted identity. Existing #119 recovery protections must remain.

UX-copy guidance informed specific, actionable uncertainty messages; the change-request
framework informed scope, impact, acceptance and rollback. No new account, key or setting.
