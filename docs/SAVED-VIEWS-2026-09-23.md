# Browser-local saved views

Source-stage feature; live acceptance is separate.

## Everyday use

Operators can open **Saved views · this browser only**, name the current active
queue filters and explicitly save, apply or delete a view. For example:

- Choose Lyf Fit in the sidebar and Changes in review filters; save **Lyf Fit — Changes**.
- Choose All Clients, Approved and Blog; save **Approved blogs**.

Applying returns to the active grid and clears search, tag and selected posts.
The interface explains this before the action. Saving is unavailable in Archived,
Templates and Suggestions; already saved views can bring the operator back to the
active queue. No view applies automatically at startup or on selection.

## Preference contract

Only a name plus client/review/status/platform/media/needs/sort preferences are
stored. No posts, content, records, search text, tag, layout, credentials or
authorization decisions are stored. Names are operator-entered labels: avoid
putting private content into them. Local preferences are not encrypted storage.

Storage uses `spool.savedViews.v1:<encoded-project>:<encoded-exact-UID>`;
the strict versioned schema allows at most 12 views with unique case-insensitive
names of 1–48 characters. Unknown keys/values, versions, oversized data and
malformed JSON are refused, not salvaged, overwritten or automatically deleted.
Browser storage failures never break ordinary filtering or claim success.
An explicit read-only retry handles temporary storage unavailability.

Saving/deleting re-reads and validates the current key immediately before writing,
so previously committed changes from another tab are preserved. This is not an
atomic multi-tab transaction; truly simultaneous writes can still race. There is
no cross-tab synchronization or cross-device sync. Different Safari installed
apps/browser profiles may have separate local storage. Clearing site data removes
these preferences; do not clear recovery records to troubleshoot saved views.

## Client and session safety

Client-specific views store a canonical roster slug, never a guessed slug or
display name. Save and Apply require a unique slug and normalized-name mapping in
the current session's loaded roster. Missing/ambiguous/loading/failed lookups leave
all filters unchanged; only an explicitly saved null client means All Clients.
Roster renames resolve the saved slug to its current display label. The existing
feed client filter remains name-based: stale historical post labels can yield an
empty/partial result, not an automatic wider scope. This feature does not repair
post labels or change authorization/query behavior.

The existing single roster hook accepts an optional session scope. Scope changes
hide old results synchronously; each effect owns its requests and visibility
listener. A→B→A and disabled→enabled start fresh owners rather than resurrecting
old results. Same-session unchanged refreshes preserve the clients-array identity;
quiet failed background refreshes keep the last successful same-session roster.
That is previously loaded roster evidence, not a fresh lookup for every action.

Saved-view UI is operator-only, keyed by project/exact UID/auth revision and retired
on unmount. Each read, write and Apply checks the live Firebase user object plus
the synchronous auth revision; stale callbacks cannot act for a later session.
These are preference/UI fences, not a replacement for auth or whole-app session
clearance. Client members and review guests never receive saved-view controls.

## Boundaries and checks

No server, rules, dependencies, API contract, post writer, review, publish, bulk
mutation or query changes. Applying clears selection as ordinary context switching
does; no selected posts are modified. Known unbounded initial reads are unchanged.

Tracked tests cover schema limits, blocked/corrupt storage, merge-before-write,
late session ownership, roster uniqueness/rename/error, and real App filters for
the two examples, search/tag/selection reset, alternate lanes and role gating.
Native-browser checks use the real App/components and generated source styles with
synthetic auth/feed/roster boundaries and no real writes or emails. Narrow/short/
desktop keyboard, labeled controls and 44px targets are scoped checks, not physical
iPhone, VoiceOver or full WCAG certification. Exact run results belong in the
dated stage archive and release review, not this source-stage description.

Rollback does not need to delete preferences: older code simply ignores this
versioned key. Keep all editor/recovery storage untouched.
