# Runbook: local Firestore rules verification

Owner: Stitch TEC operator / reviewed engineering change
Frequency: before proposing a rules release; as needed after rules or emulator changes
Last updated / last native run: October 1, 2026 (America/Phoenix)

## Current decision: held

This is local preparation, **not deployed rules or accepted release evidence**.
The final native run has **64 passing cases and one failing case out of 65**.
The failure is an ordinary member's unconstrained `users` collection listing:
the operation is denied, but the emulator reports `Null value error` at the users
read rule. A wrong reason for denial is not a passing security assertion. This
run did not demonstrate an unauthorized grant from that remaining diagnostic.
Do not merge, activate rules or exempt the diagnostic to make this gate green.

The earlier 34-case suite passed while emulator output contained 1000-expression
exhaustion and other evaluator faults. `assertFails` alone accepted those denials.
The new wrapper and full-run evidence check catch this false-green condition.

## Prerequisites

- Node 22, npm and Java 21 on `PATH`; installed lockfile dependencies.
- macOS or Linux (the runner owns a POSIX process group).
- No inherited `FIRESTORE_EMULATOR_HOST` and no arguments or provider project overrides.
- Firebase CLI is pinned to `15.22.3`; the recorded Firestore emulator is `1.21.0`.
  First use may download CLI/emulator artifacts. No real project or credentials are needed.
- Work in this repository. All fixtures are synthetic; never substitute a live project.

## Procedure

1. Run `npm test`, `npm run lint` and `npm run build`.
   These must pass, but ordinary tests deliberately skip the emulator suite.
2. Run `npm run test:rules`.
   The runner creates `.rules-test/run-<unique>/`, an isolated loopback emulator and
   fixed `demo-spool-rules` project. It invokes only `firestore.rules.test.js`.
3. Inspect that run's `verification.json`, `vitest.json`, `runner.log` and
   `firestore-debug.log`. Preserve them together with exact source hashes.
   Success requires exit 0, `ok: true`, one exact owned suite, all assertions passed,
   zero skipped/todo tests and no concrete evaluator fault anywhere in either log.

If a rule or fixture fails, stop and investigate the exact operation. A positive
case must succeed; a negative case must return an intentional denial without an
evaluator exception. Pair valid maximum values with one-over denials and check
that denied writes preserve saved history. Do not reduce field/history limits,
remove assertions or change authorization to satisfy the harness.

## Diagnostic contract

The classifier rejects expression exhaustion, null/undefined/type/function errors,
index errors and `EvaluationException` traces even when the message also says
`false`. It rejects malformed, missing, inconsistent or skipped test reports.

One precisely parsed diagnostic form is reported separately, not treated as a
concrete fault: location-only `evaluation error at L… for '…' @ L…` clauses followed
only by `false for '…' @ L…` clauses. Native constant-false, null-safe-false,
RBAC-false and undefined-property controls establish that emulator 1.21.0 emits
this form for an ordinary RBAC predicate that returns false. Additional text,
unknown grammar or a concrete exception on any line still fails. This is not a
blanket exemption for errors and is not a claim of zero diagnostic lines.

The runner bounds elapsed time (180 seconds) and output (8 MiB). Interrupt,
termination, repeated signals, overflow, spawn failure and normal exit clean up
the owned process group; termination escalates to kill. Any interruption fails
acceptance. Do not attach this runner to somebody else's emulator.
An external SIGKILL or host crash cannot run cleanup; the five signal tests cover
handled signals, not crash recovery. Timeout/overflow paths were source-reviewed.

## Narrow rules preparation

The proposed rules cache shared member admission, data and changed-key evidence,
then route disjoint member operations: changed `reviewedAt` selects review;
otherwise changed `sentForReviewAt` selects resubmit; otherwise editorial.
Each complete original field/value validator remains. Actor permissions remain a
union: a valid guest grant still works beside another tenant's member grant, and
a valid member grant is not suppressed by malformed guest claims.

Missing claims and malformed review structures are checked before dereferencing;
empty review threads are not indexed. Legacy approval without a feedback field
remains allowed. Owner fallback and super-admin operations remain; email-less
owners still cannot write user grants. Maximum feedback/history and editorial
limits are unchanged. The last run contains no expression-exhaustion, undefined
property or index diagnostic, but the one users-list null diagnostic keeps it held.

**Deliberate tightening:** role containers must be lists. Previously, map keys such
as `{ client: true }` could satisfy role membership. Such malformed grants are now
rejected; valid client/client-admin and mixed role lists retain their behavior.
Before any later live activation, inspect real role shapes read-only and assess
impact. No such inventory, role repair or live access change occurred here.

## Recorded verification and limits

- Ordinary suite: 1,324 passed, 65 emulator cases skipped; includes 27 classifier tests.
- Lint and production build: passed. No dependency or lockfile changes.
- Native final: 64/65; strict exit 1. No further native optimization runs after this result.
- Review, mixed-role/claim, tenant denial, selector, 500-character/200-entry boundary,
  maximum editorial, legacy approval and operator cases passed.
- Protected `shares`/`automations` assertions later in the failing users-list test
  were **not reached**. Do not claim this run verified those later assertions.
- Five independent synthetic process-group signal cases passed, including repeated
  SIGINT, repeated SIGTERM and mixed signals; this tests local runner ownership,
  not real account/session behavior.
- Helper classification was strengthened after the native run for two concrete
  baseline diagnostic forms; re-reading the captured final evidence still rejects
  the same null diagnostic. No new native run is implied by this offline check.

Suite evidence is under `_archive-2026-10/spool-security-rules-20261001/rules/`:
`baseline-34/`, `baseline-extended/`, `CONTROL-*`, `final-held/` and
`independent-runner/`. Base source is `eabffb8c4220abb76d10a41fa73a05632dae31d4`.
Final rules SHA-256: `61f96820bfab9a09feb71b591de9e1cf9b08d079d76c32673492d2d188460fec`.
Final native tests SHA-256: `53b89845810324126f877dd6a42d0b35025e3e39ea4abb70ddf8e2a35ac6aec5`.

## Troubleshooting, recovery and escalation

If Java, dependencies or artifact download fail, fix the local prerequisite and
record the failure separately; no rules conclusion follows. If ownership cleanup
fails, identify only the runner's captured process group and ask for review—never
kill arbitrary Java/Node processes. Preserve failure evidence before cleanup.

There is no production rollback: nothing was deployed. Keep proposed rules source
separate and held; the runner may be reviewed independently. The next decision is
a separately scoped investigation of the users-list diagnostic with explicit
query/authorization acceptance, not a quiet get/list policy split. Obtain owner
approval before any live permission/policy change or protected release override;
perform any necessary inventory read-only with existing authorized access and
minimum data. No real inventory is claimed here.
