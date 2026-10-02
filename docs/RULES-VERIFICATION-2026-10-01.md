# Runbook: local Firestore rules verification

Owner: Stitch TEC operator / reviewed engineering change
Frequency: before proposing a rules release; as needed after rules or emulator changes
Last updated / last native run: October 1, 2026 (America/Phoenix)

## Current decision: rules tests pass; release preparation continues

The strict native suite now passes **75/75**. Own-account access compares the exact
affected request path instead of an unresolved wildcard string. This preserves
own-document reads and document-ID filtered queries while denying broad or foreign
queries without the earlier null-value error. The protected-collection checks run
independently. This is local rules evidence; release still needs the combined
dependency/access candidate and review. Live rules activation is a separate step.

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
concrete fault: optional leading location-only `false` clauses, location-only
`evaluation error at L… for '…' @ L…` clauses, then only final `false` clauses.
Native constant-false, null-safe-false,
RBAC-false and undefined-property controls establish that emulator 1.21.0 emits
this form for an ordinary RBAC predicate that returns false. A 240-case native
users-query control matrix also verifies the leading-false form for mixed-ID
queries and identical permission/results between the old and new ownership checks.
Additional text,
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
limits are unchanged. The final 75-case run contains no concrete expression,
null, undefined-property, function or index error. Users still read only their
own account; operator and super-admin directory permissions are preserved.

**Deliberate tightening:** role containers must be lists. Previously, map keys such
as `{ client: true }` could satisfy role membership. Such malformed grants are now
rejected; valid client/client-admin and mixed role lists retain their behavior.
Before any later live activation, inspect real role shapes read-only and assess
impact. One bounded read-only inventory attempt matched the operator account but
stopped because Google required reauthentication before any Firestore read. Counts
remain unavailable, not zero; no role repair or live access change occurred.

## Recorded verification and limits

- Ordinary suite: 1,330 passed, 75 emulator cases skipped; includes 33 classifier tests.
- Lint and production build: passed. No dependency or lockfile changes.
- Native final: 75/75; strict exit 0 and `verification.ok: true`.
- Review, mixed-role/claim, tenant denial, selector, 500-character/200-entry boundary,
  maximum editorial, legacy approval and operator cases passed.
- Protected `shares`/`automations` checks now run in independent cases and pass.
- Five independent synthetic process-group signal cases passed, including repeated
  SIGINT, repeated SIGTERM and mixed signals; this tests local runner ownership,
  not real account/session behavior.
- Classifier changes are included in the final native run. The previous 64/65
  failure and all-green 34/34 false-positive report remain retained as historical
  evidence; both still fail strict acceptance.

Suite evidence is under `_archive-2026-10/spool-security-rules-20261001/rules/`:
`baseline-34/`, `baseline-extended/`, `CONTROL-*`, `final-held/` and
`independent-runner/`. Base source is `eabffb8c4220abb76d10a41fa73a05632dae31d4`.
New control/final evidence is in the adjacent suite archive
`_archive-2026-10/spool-security-rules-followthrough-20261001/` (`CONTROL-*` and
`full-native-final/`). Final rules SHA-256:
`2ac25d7b8522913eec2c2eca9c4e16dabfd1b926235670e7d7292dcbcd4f489b`.
Final native tests SHA-256:
`36967eddc69225d8adcdc9d81d788352926a49f3a14116e55b124d7bc1d5d003`.

## Troubleshooting, recovery and escalation

If Java, dependencies or artifact download fail, fix the local prerequisite and
record the failure separately; no rules conclusion follows. If ownership cleanup
fails, identify only the runner's captured process group and ask for review—never
kill arbitrary Java/Node processes. Preserve failure evidence before cleanup.

There is no production rollback: nothing was deployed. Keep proposed rules source
separate until the integrated candidate passes its release checks. The users-list
issue is resolved with equivalent query behavior, without splitting get/list policy. Obtain owner
approval before any live permission/policy change or protected release override;
perform any necessary inventory read-only with existing authorized access and
minimum data. The stopped attempt is in the follow-through archive's
`ROLE-SHAPE-INVENTORY.json`; no real role-shape inventory is claimed here.
