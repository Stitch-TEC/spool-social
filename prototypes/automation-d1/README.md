# Spool automation-config D1 pilot — local / synthetic only

**Date:** September 7, 2026 · **Status:** local prototype; not live or execution-ready.
Source baseline: `c2f747cc42147c4f6c75a974d1b6eb8f8d99cf6a` (Spool main, PR #109).

The long-term direction is Cloudflare-first POMP, Cloudflare-only where sensible.
Google sign-in may remain. This experiment answers a narrow question: can Spool's
Worker-owned automation configuration preserve its data contract behind a D1-style
storage adapter? It does **not** migrate Firebase, authenticate users, generate content,
change billing, or replace recovery/backup work.

## What exists here

- `store.mjs`: normalized-record validation, owner-scoped prepared SQL, stable-ID
  pagination, due selection, optimistic revisions, exact retry handling, and an
  owner/slug retirement fence committed atomically with configuration scrubbing.
- `schema.sql`: a fresh-database prototype schema **outside production migration paths**.
  Indexed fields support owner/client/due queries; JSON preserves the flat Firestore
  record and absence of optional legacy fields. SQL checks enforce key consistency.
  Prototype schema v2 adds the retirement-fence table; v1 is refused, not auto-upgraded.
  This file creates fresh synthetic databases only, not a live schema migration.
- `local-harness.mjs`: a small D1 API approximation over Node's in-memory SQLite.
  It accepts no database filename, URL or credentials; no durable database is created.
- `fixtures.mjs`, `pilot.check.mjs`: invented records and independently runnable tests.
- `emulator.check.mjs`: an additional local workerd D1 SQL/binding smoke test through
  lockfile-installed Miniflare, with ephemeral storage and outbound requests denied.
- `retirement-contract.mjs`: the same ten adversarial retirement cases, shared by
  the Node SQLite and local workerd/D1 checks.
- `benchmark.mjs`: fixed synthetic local timing exercise, not an edge-performance test.

There are no runtime imports, package-script changes, bindings, Firestore exports,
provider calls, production queries, new deployment steps or data-transfer commands.
The app still exclusively uses the existing Firestore automation store.

**Publishing warning:** `.github/workflows/deploy.yml` deploys on **every push to main**,
without a path filter. Merging this folder alone would therefore trigger the existing
production deployment, even though the prototype is outside the application import graph.
Do not merge under a “no deployment” assumption. This local task does not alter the
workflow or bypass its gates; a release decision or separately reviewed deployment-filter
change is required first. Prototype checks are manual, not added to ordinary CI.

## Local checks

Use Node **22.19.0** (the repo's deployment toolchain); Node 25.2.1 was also checked.
Node's SQLite API is experimental in these versions and prints a warning.

```sh
node --test prototypes/automation-d1/pilot.check.mjs
node prototypes/automation-d1/benchmark.mjs
```

Run from this repository root. The scripts use built-in modules only; no dependency
installation, login, Wrangler command, environment variable or real fixture is needed.
These two scripts open `:memory:` databases only and block unexpected `fetch` calls.
No command above deploys, reads Firestore or executes AI. Do not substitute real client data.

For the **additional local D1 smoke test only**, install the existing lockfile dependencies
first (`npm ci`, Node 22.19.0), then run:

```sh
node --test prototypes/automation-d1/emulator.check.mjs
```

This uses the lockfile-installed Miniflare/workerd dependency already supplied by Wrangler;
no dependency/lockfile change or Wrangler command is required. It starts a loopback-only
development runtime on an ephemeral port, disables Cloudflare metadata fetching (`cf: false`),
uses synthetic D1 with persistence off, denies outbound Worker requests, and disposes the
runtime in `finally`. It does not load the production Wrangler configuration or credentials.

The adapter follows the documented D1 `prepare().bind().first()/all()` and transactional
[`batch()`](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch) shape. This
small SQLite harness is **not workerd or a D1 emulator**. The separate local D1 smoke
does exercise the schema and binding calls against workerd, with the adapter invoked
from Node. Neither is a bundled-app/production compatibility proof, edge concurrency or
read-replica test, staging acceptance, or a measurement of Cloudflare latency/cost.
References: [D1 prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/)
and [Node SQLite](https://nodejs.org/download/release/v22.19.0/docs/api/sqlite.html).

## Contract and deliberate differences

Current contract sources: `worker/firestore.js` automation helpers (~1195–1276),
`worker/index.js` automation validation (~94–141) and routes (~2338–2518), and
`worker/automation.js` scheduled-result writes (~350–377).

| Concern | Local prototype behavior |
| --- | --- |
| Identity | Existing 20-character alphanumeric ID, owner UID and canonical client slug retained. Never generates a replacement identity or guesses a roster slug. |
| Authorization | Every data operation is scoped to the constructor's owner UID. This UID must come from a separately authorized caller; the adapter is **not** authentication or an HTTP authorization layer. Existing operator-only route checks remain required. |
| Records | Strict normalized flat fields, bounds and enums; unknown/invalid rows fail closed without coercion. Missing optional `grounding`, `mode`, `pageCursor` stay missing. Any actual legacy incompatibility requires reviewed inventory/quarantine, not silent repair. |
| Updates | ID, owner UID, slug, platform and creation time cannot change. A revision predicate makes updates compare-and-swap; conflicting edits are not last-write-wins. Revision is a new storage envelope, not a changed Firestore field. |
| Retries | An identical initial create or immediately preceding patch at the same expected revision is idempotent. Different payloads, later edits or tombstones conflict. This is not an unlimited operation journal. |
| Schedule / cursor | Compound patches commit schedule, cursor and count together. Tests preserve success/error/preview field combinations; budget refusal has no write. No scheduler or generation code is executed here. |
| Lists | Explicit bounded pages ordered by stable ID; not a drop-in replacement for Firestore's array/list order. Callers would need pagination and their existing presentation sort. Due rows are oldest first with stable ID tie-breaking. No multi-page snapshot guarantee. |
| Rename / remove | Display-name edit preserves immutable slug and run state. Removal scrubs configuration and retains a minimal identity/revision tombstone, blocking delayed recreation. Tests keep other owners/clients unchanged. |
| Client retirement | `retireClient(clientId, retiredAt)` adds an owner/slug fence and scrubs matching active configs in one SQL batch. Guarded create/CAS/read queries reject late requests even with new IDs. `retirement(clientId)` returns only original owner/slug/time/count evidence. |

### Retirement follow-through — bounded prototype proof

The first pilot's per-record tombstones only blocked reuse of a removed automation ID.
A delayed create using a **different** ID could still recreate configuration for the same
client. Schema v2 closes that storage-layer gap with an owner + immutable-slug fence.

The fence, initial active-row count and configuration scrub commit together. A failed
statement rolls back the whole batch; a lost acknowledgement can be retried. Repeated
retirement retains the original `retiredAt` and `scrubbedCount`, rather than pretending
a retry is a second retirement. Already-scrubbed records do not gain another revision.
The count describes the initial committed operation, not a new live inventory on each read.
Prompts, display names, last errors and configuration payloads are not retained in fence
evidence. Original automation IDs and owner/slug namespaces are preserved in tombstones.

The exact same ten cases run on both local engines: owner/slug isolation; empty-client
fencing; create/update/remove races; corrupt unscrubbed rows hidden by the fence;
concurrent/repeated retirement; lost acknowledgement; rollback after the fence or scrub;
and invalid scope/time rejection. No real client was retired or removed.

This is not a client-roster status or a second roster. A trusted, separately authorized
lifecycle caller would supply the owner and slug. It does not undo reads already returned,
cancel in-flight AI or posts, stop old non-adapter writers, or establish full lifecycle
acceptance. There is **no expiry, unfence, reactivation or tombstone-purge API**; retention
and re-onboarding behavior remain an explicit future policy decision, not an assumed
permission to retain real records indefinitely.

### Unclosed correctness gates

1. **No exactly-once generation claim.** A result-write CAS does not prevent two runners
   from calling paid AI or creating posts before one loses the CAS. Live use needs a
   separately designed execution lease/idempotent post-creation boundary and crash tests.
   Storage retries alone cannot safely retry paid generation or external effects.
2. **Lifecycle integration is incomplete.** The real broker-driven client purge currently
   hard-deletes automation documents. The prototype keeps ID/owner/slug/creation/revision
   metadata to reject stale writes, but scrubs prompt/config/last-error data. The new
   prototype owner/slug fence adds local delayed-write protection only. Tombstone/fence
   retention, reactivation and eventual hard-purge semantics need an explicit decision, plus reviewed
   rename/purge receiver integration, counts/errors and bounded enumeration. No claim of
   production hard-delete parity is made.
3. **No live schema or migration inventory.** Strict validation covers the current normalized
   source contract; no actual stored records were read. Storage caps do not replace existing
   per-owner/per-client creation caps or rate/budget checks in the API and runner.
   Existing route validation, operator authorization and canonical-roster resolution/repair
   must remain in place. A slug-shaped value is not proof that the roster contains it;
   this local store deliberately does not create a second roster or resolve client names.
4. **No current authentication/storage replacement.** Firebase Auth, posts, review state,
   custom guest tokens, live subscriptions, branding and client membership are untouched.
5. **No recovery acceptance.** A successful SQL test does not provide a backup, point-in-time
   recovery, independent failure alert or accepted restore rehearsal.

## Change record and next approval boundary

**Requester:** platform owner · **Priority:** low-risk learning alongside recovery work.
**Approved scope:** local synthetic implementation only. **Live activation:** not approved.

Why: reduce migration uncertainty in the least-coupled Spool data slice before considering
the much larger posts/realtime/authentication work. This stage requires developer review,
not client training; app users see no change and no new paid services are provisioned.

| Impact / risk | Assessment and boundary |
| --- | --- |
| Users and runtime | None from local work. No client messages or workflows change. |
| Data and cost | Ephemeral local invented data; no cloud resource created or AI invoked. Real billing and website leads are wholly excluded. |
| False readiness | Material risk if local tests are read as D1/live acceptance. Keep this folder labelled prototype and retain all gates above. |
| Publishing | Main auto-deploy is an actual release side effect; no merge is authorized merely by passing this prototype. |
| Rollback | Stop the local process; its synthetic database disappears. Existing production behavior is unchanged. Do not run a production rollback or delete any real data for this task. |

Recommended next review milestones, not execution instructions:

1. Independent source review and repeat local tests; record compatibility limitations.
2. Decide whether this slice is worth advancing relative to recovery and Sender separation.
3. If approved separately, extend the completed bounded local D1 smoke into adversarial
   runtime integration tests, and design lifecycle retention, runner idempotency and a
   storage-adapter API cutover. The smoke alone does not close these integration gates.
4. Before any live change, require exact target ownership, synthetic staging evidence,
   consistent backup/restore proof, all-writer freeze (API, cron and lifecycle), inventory,
   rollback/fix-forward boundaries and explicit activation approval. No dual writers.

Communicate the review outcome to the owner before expanding scope. Sustain the boundary
by keeping later evidence distinct: local proof, provider compatibility, staging acceptance
and live verification must not be merged into one “done” claim.

## Evidence from this local implementation

Initial **schema v1** Node 22.19.0 benchmark (one local run, September 7; historical,
not a timing measurement of the added v2 retirement predicates and not statistically meaningful):
1,000 inserts **252.167 ms**, 1,000 ID reads **82.261 ms**, five pages/1,000 rows
**28.572 ms**, due query/200 rows **8.906 ms**. Includes JavaScript validation/serialization
and in-process SQLite; excludes network, edge scheduling, durability, authentication,
replication and provider billing. Repeat runs will differ.

Final local checks, September 7:

- Prototype: **56/56 checks passed** on Node 22.19.0 and Node 25.2.1.
- Separate local workerd D1 checks: **11/11 passed** on Node 22.19.0 (8.76 seconds total
  in the first v2 run). Exercised schema/prepared statements/`RETURNING`, duplicate
  create retry, owner isolation, pagination/due queries, racing CAS, remove retry and
  tombstone non-resurrection, plus the ten shared retirement cases. No remote Cloudflare
  resources were used. These checks remain separate from ordinary hosted CI.
- Existing repository suite on Node 22.19.0: **505 passed, 30 skipped** with
  `npm test -- --maxWorkers=2` (Firestore emulator/rules checks were not run in this
  task; source/rules were unchanged). An initial run during a parallel build hit the
  existing five-second timeout in the unchanged encoded-pagination test in
  `worker/firestore.test.js`; that file then passed **18/18** alone, followed by the
  full bounded-concurrency pass. No assertions, timeouts or application source changed.
- Full-repository lint passed; Vite build passed using dummy Firebase build values.
- The initial pilot's `npm ci` reported **zero vulnerabilities**. This follow-through
  changes no dependency or lockfile and does not claim a new provider audit baseline.

The existing suite does not automatically run `pilot.check.mjs`; its explicit command
above is separate evidence. No Firestore rule deploy, production deploy or real-device
acceptance was performed or claimed.
