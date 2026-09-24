# Exact-content reuse during feed updates

## Scope

This change avoids repeating successful media-markup normalization when a post's
raw content is exactly unchanged in a later metadata-only Firestore snapshot.
`docChanges()` already processes only changed documents; this does not claim
that every update reparsed the entire workspace before the change.

The first snapshot, a reconnect's first snapshot and actual content changes
still normalize. There is no query, pagination, Firestore rule, API contract,
dependency, configuration, persisted data or browser-storage change. Initial
network reads remain unbounded and whole-workspace search/facets/export remain
unchanged. This is not a cold-start or network optimization.

## Private ownership and invalidation

`usePosts` keeps a private `WeakMap` per listener attempt, keyed by the existing
normalized post object. It stores the exact primitive raw content string, its
successful derived output, actual Firestore document ID, owner UID and client
slug. Nothing is added to the returned post's string/symbol properties, so
editor spreads, approval baselines and writers gain no raw-content/cache field.

A hit requires a modified, still-present document in the current attempt with
matching actual document ID, exact raw string, valid owner UID and canonical
client slug. Suggestions, implied `forClientId` tenants and missing/malformed
ownership are deliberately not cached. Non-string legacy content always runs
through the existing coercion and compatibility path; mutable object identity
is never a cache key.

Metadata-only updates still build a new post from current data and recompute
title/content search, client search, dates, sorting, tags and image URL. The
cached derived string is used rather than trusting a consumer-mutated
`existing.content`. The captured review's original post is never mutated.

Superseded and removed entries are explicitly evicted. Every new listener gets
a new map, and termination, denial and cleanup discard it. Auth/session/query
ownership and obsolete-callback fences remain unchanged. A remove/re-add, even
inside one synthetic snapshot, cannot reuse a removed row's normalization.
There is no global, persistent, cross-listener or cross-client cache and no
strong map retaining every historical document.

## Compatibility fallbacks remain retryable

The existing media helpers can fall back to raw or partially transformed copy
when a parser throws. Treating that as a successful cached result would prevent
a later snapshot from trying again. A no-argument optional internal observer
now reports each existing catch: micromark, parse5 and the outer display helper.
The hook does not cache a result after any such notification.

Default return values, parser algorithms, configured media-origin rules and
logging are unchanged. The observer receives no content or error data, and its
own exceptions/non-callable values cannot turn a compatibility fallback into a
display crash. A failed parse still displays the same fallback; a later update
tries again and only a successful result becomes reusable. The normalizer's
origins are module-lifetime configuration, not the current browser hostname.

The media-markup parser is shared with `worker/media.js` and `worker/firestore.js`.
Its optional observer therefore changes the Worker bundle too, even though no
file under `worker/` changed. The three server call sites still pass two arguments;
their default output and catch behavior are unchanged. Server media identity,
draft-output versioning and image-reference collection require regression review,
and deployment verification must compare the changed uploaded Worker bundle with
a build of the reviewed source, not assert an unchanged Worker script checksum.

## Verification and limits

The dedicated actual-hook tests cover metadata/title invalidation, exact string
changes, Markdown/HTML/escaped/media/prose output equivalence, missing and
malformed legacy values, mutable legacy coercion, tenant/UID/document ownership,
suggestions, consumer mutation, no exposed fields, removal/re-add, reconnect,
scope/session/sign-out/denial, stale callbacks, unmount and StrictMode output.
One-shot outer/micromark/partial-HTML failures prove fallback → retry → successful
reuse, including an observer that itself throws.

Private eviction can make development StrictMode or concurrent updater replay
normalize again. The guarantee is equivalent visible output and scoped reuse
when available, not exactly one parser invocation in every React execution.

The performance evidence uses the production-built actual hook and React with
synthetic Firestore transport, two warmups and five retained repetitions per
case, in desktop Chromium/WebKit at a mobile viewport. It compares initial
400-row snapshots with 1/20/400-row metadata deltas and changed-content updates;
rows are independently JSON-decoded outside the timers. It does not time
Firestore, the complete application or a physical iPhone, and establishes no
real workspace distribution. The suite's dated stage archive contains exact
baseline/candidate hashes, raw timings and independent checks.

Rollback is a source-only revert of this bounded change on top of #123. Keep
the #122 feed isolation, #123 captured-review ownership and #119 uncertain-save
recovery intact. Do not clear storage, alter data/rules or claim to cancel an
already-dispatched write as part of performance rollback.
