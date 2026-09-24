# Image cleanup stops on incomplete reference parsing

## Problem and bounded change

The existing shared markup parser preserves display compatibility by catching
Markdown/HTML parser failures and returning raw or partially transformed text.
That is appropriate for displaying a draft, but not for deciding that an image
has no references. A caught failure could leave the cleanup reference inventory
empty or incomplete without triggering its existing no-delete failure path.

This was reproduced with invented parser failures in baseline `c4020c11`, not an
observed production incident or confirmed deletion. The preceding content-reuse
change did not introduce this behavior.

Only `worker/firestore.js` runtime code changes. `collectPostImageReferences`
supplies the shared parser's existing optional error observer, records a local
failure flag, and throws a fixed error **after** parsing returns if the flag was
set. Throwing inside the observer would not work: observer exceptions are
deliberately swallowed to preserve other callers' compatibility behavior.

The existing chain then rejects safely:

`collectPostImageReferences` → `listAllImageUrls` rejects → `runGC` inventory
guard logs failure and returns **before any R2 object-listing or deletion call**.

An earlier document, cover image or Markdown segment may already have added
references to the internal Set when an HTML failure is reported. That Set is
not returned as a successful complete inventory. The exception must propagate;
callers must not catch it and proceed with the partial Set.

## Unchanged behavior and limits

- The shared parser and its display, content-identity and output callers are
  unchanged. Their raw/partial fallback still works as before.
- Healthy inline/reference/escaped Markdown, HTML image/source `srcset`, entity
  references, cover fields, external URLs, ordinary prose and code are collected
  with the same parser rules. Missing projected fields remain valid; malformed
  present fields still reject through the existing shape check.
- Firestore queries/projections/pagination, authentication, R2 generated-prefix
  scope, grace window, schedules, AI automation, configuration, dependencies and
  browser code/storage are unchanged.
- This is a Worker runtime/bundle change. It is not a UI or cold-load performance
  improvement and requires exact reviewed-source/deployed-bundle verification.
- A subsequent healthy run is not poisoned by an earlier parser failure. No new
  retry, monitoring, cleanup activation or manual production sweep is introduced.
- This closes caught-parser uncertainty only; it does not redesign concurrency
  between independent content writes and the existing mark-and-sweep process or
  claim that every possible cleanup failure has been audited.

## Verification

`worker/gcParseSafety.test.js` adds 34 focused cases using the actual collector,
`listAllImageUrls`, `runGC`, shared parser and parser packages. One-shot wrappers
throw at micromark preprocessing/parsing/postprocessing or parse5 HTML parsing;
every fault case asserts that the intended wrapper really ran.

Coverage includes initial failures, partial HTML results after successful
references, later documents, a later Firestore page, healthy subsequent collection,
unchanged default server display/identity fallback, query/cursor shape, and zero
R2 list/delete calls on uncertainty. Healthy simulated sweeps still preserve
referenced/recent/unknown-age objects and select only the invented old orphan;
a positively completed empty inventory remains a valid result.

All transport, authentication crypto and R2 bindings in these tests are local
fakes. No credentials, service account, real Firestore data, image deletion,
scheduled event or production cleanup is used. Fake delete-spy calls in healthy
controls are assertions, not real storage operations.

The suite archive preserves an exact virtual baseline from `c4020c11`, without
overwriting the checkout: 25 desired safety assertions fail and nine healthy/
compatibility controls pass before the fix. After the fix, all 34 pass; the
author's focused collector/Worker/parser run passes 94 tests across four suites.
Full gates, independent acceptance and release evidence are separate records.

## Rollback

Prefer a narrowly reviewed fix-forward if this conservative stop behavior causes
trouble. Reverting this collector change restores the known incomplete-inventory
risk; do not describe the previous version as equivalent cleanup protection.
Preserve the preceding feed/review/save safeguards and all data/configuration.
No storage clearing, data migration or manual production cleanup is an acceptance
or rollback step. Use synthetic no-list/no-delete tests and public read-only
release identity checks instead.
