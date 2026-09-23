# Guest review selection ownership — September 23, 2026

## Problem and boundary

Spool #122 protects the feed's subscription state. An already-open guest review
was a separate captured `reviewingPost` object and could remain visible after
the feed cleared. Six actual-App synthetic probes reproduced retention after
different/same-UID sessions, share-scope changes, deletion and explicit access
denial. The path existed before #122; no historical client incident or successful
unauthorized write was established.

This slice changes only ownership of that guest review window and its UI action
completion. It does not broaden review eligibility or modify Firestore rules,
queries, tokens, Worker APIs, database data, recovery storage or dependencies.
Release status and deployment identity belong to the suite's release record.

## Selection contract

`useReviewSelection` owns a distinct token for every opening, the original selected
post object, and the exact viewer User object, UID, existing auth revision, role,
member client and immutable share-owner/client scope.

The review is immediately hidden and retired when the viewer changes, auth is
unresolved, the live auth revision no longer matches, explicit authorization is
denied, or its current authorized feed membership disappears. Membership checks
the same ID **and** immutable `clientId`/`uid`, `in_review`, and not a suggestion.
Private/missing-stage rows cannot remain in review. Returning to the former
session/scope/post cannot resurrect that retired selection or its typed feedback.

Ordinary same-ID copy, metadata and schedule changes do **not** replace the
original selection. Same-scope transient connection warnings keep the review and
typed feedback mounted while the existing feed retains authorized rows. Archived
rows remain viewable under the existing disabled-action/CAS contract.

## Approval and async completion

- The original displayed post remains the consent baseline passed to the existing
  exact-content/review-state transaction. A newer unseen revision is never
  silently substituted and approved. Existing CAS conflicts remain actionable.
- Modal actions check current selection, live membership and the synchronous
  auth-revision getter before dispatch—even before React renders changed auth.
- Close/open invalidates the token immediately in the event handler. A pending
  result from an older A cannot close or toast into reopened A or later B, even
  when close/reopen and completion occur in one React batch.
- Success and error handling check the originating selection again after the
  await. Ordinary direct-card/workflow operations keep their existing contracts
  and no longer close an unrelated guest review window as a side effect.
- An already-dispatched transaction can still commit. This change suppresses
  obsolete UI completion; it does not cancel, undo or guarantee delivery of a
  write. Feedback byte handling, attribution and transaction guards are unchanged.

## Verification

The focused author suite has 50 tests across the new hook and actual App/real
ReviewModal/real CAS helper, with synthetic auth/feed and Firestore transport.
Coverage includes the six original cases; first-render fencing and no
resurrection; same-ID ownership/stage changes; same-UID User replacement; explicit
denial with deliberately retained rows; synchronous revision rejection;
same-batch old success/error after reopening; transient feedback preservation;
same-ID changed-content conflict; exact feedback; normal close focus return;
archived/CAS behavior; malformed legacy-date safety; StrictMode and unmount.

The stage archive records ordinary gates, independent source review and actual
Chromium/WebKit replay before release. No real client data or authenticated
production action is needed. Synthetic browser evidence is not physical-device,
VoiceOver or whole-app session-clearance certification.

## Rollback and remaining limits

Use a narrow reviewed fix-forward or revert if needed. Do not revert #122 feed
ownership or the #119 interrupted-create floor, erase recovery records, change
permissions or modify remote content as a rollback step. This patch closes the
captured guest-review path only; it is not certification of every other open
application surface. Initial feed read bounding/performance remains separate.
