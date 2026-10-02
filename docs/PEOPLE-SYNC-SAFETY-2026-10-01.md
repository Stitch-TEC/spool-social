# Spool client-access sync guards

Status: source preparation only. This document is not deployment proof. The existing
dependency audit is currently red; no gate is weakened or bypassed by this change.

## Scope

`POST /api/people-sync` keeps its existing internal-key-only authentication, rate limit,
and grant/revoke contract. The broker still owns requests; this is not a new browser
action, single sign-on, automatic reconciliation, or an app-access checking endpoint.
No roles, grants, client records, rules, secrets, schedules or other production data
are changed by preparing or testing the source.

The receiver accepts ordinary `client` records for the exact requested client slug.
It refuses another tenant, any privileged role, unknown/malformed roles, and malformed
identity fields. A legacy ordinary-client record may omit its redundant email field;
its exact document ID, client slug and roles still have to match. An email field that
is present must match exactly. Existing operator authentication and the `OWNER_UID`
operator bypass are unchanged; this route never grants operator roles.

## Conditional writes

The dedicated writer reads one exact Firestore document and validates its resource
name, typed fields and update-time revision. A missing grant uses `exists:false`;
an existing grant or revoke uses the exact observed `updateTime`. Grant updates only
the existing five managed fields (`roles`, `email`, `clientId`, `updatedAt`, `source`),
preserving unrelated fields. Revoke removes only an admitted same-tenant ordinary
record. An already absent revoke performs no write.

One atomic [Commit](https://firebase.google.com/docs/firestore/reference/rest/v1/projects.databases.documents/commit)
contains exactly one [Write](https://firebase.google.com/docs/firestore/reference/rest/v1/Write),
with the mask and [Precondition](https://firebase.google.com/docs/firestore/reference/rest/v1/Precondition)
in JSON. No transaction retry loop or extra transform is submitted. Native local testing
accepted missing-record creation, current-revision update/delete, and refused stale
conditions after both privileged-role and tenant changes without altering those records.

The initial [PATCH](https://firebase.google.com/docs/firestore/reference/rest/v1/projects.databases.documents/patch)
and [DELETE](https://firebase.google.com/docs/firestore/reference/rest/v1/projects.databases.documents/delete)
query-precondition approach was not retained: the local emulator rejected a matching
ISO timestamp while reporting a zero base version. That is preserved as a compatibility
finding, not a proven production API defect. The typed Commit body passed the bounded
replacement native experiment.

A role promotion, reassignment, deletion or creation between the read and write
makes Firestore reject the condition. The receiver does not retry or rebase against
the new record. Response bodies are bounded to 64 KiB, Firestore read/write requests
have six-second abort signals, and those requests refuse redirects. The existing
shared service-account token exchange is unchanged and is not a new overall deadline.

The unchanged success fields remain `ok:true` and `status:granted|revoked`. The response
also echoes the exact normalized `email`, `clientId` and `action`. Commit acknowledgement
requires one positional [WriteResult](https://firebase.google.com/docs/firestore/reference/rest/v1/WriteResult)
and a valid commit timestamp. Grant requires an update timestamp (which may be unchanged);
delete must omit it. No nonempty transform results are accepted. The provider does not
echo document identity or saved fields in this response: this is acknowledgement of the
one submitted conditional operation, not a readback, future sign-in, or cross-app session
verification. An absent revoke is an observation, not a lock against a later grant.

## Failure and recovery contract

- `client_mismatch`, `privileged_account_hand_managed`, or `malformed_access_record`
  (409): refused before mutation; review the existing identity rather than forcibly
  moving or downgrading it.
- `access_changed` (409): the conditional attempt was rejected. Start a fresh,
  deliberately reviewed action; no automatic retry occurs in this receiver.
  This includes the native emulator's HTTP 400 only when the provider explicitly
  reports `FAILED_PRECONDITION`; arbitrary bad requests stay unconfirmed.
- `access_read_unavailable` / `access_record_unverifiable` (502): no write was sent.
- `sync_outcome_unknown` (502): a submitted mutation was not confirmed. It may have
  committed. Do not revoke/regrant or blindly repeat as a substitute for inspection.

The legacy broker maps 409 to `blocked` and other failures to `error`; it does not yet
read back Spool access or validate the echoed identity fields. Canonical POM desired
flags remain separate from this acknowledgement. A later read-only verification and
single-app re-sync contract needs its own broker/receiver/UI review. Sender, POM
directory writers, client-lifecycle purge, and shared login reads are outside this slice.

## Verification and release boundary

`worker/peopleSync.test.js` uses the actual router and a synthetic conditional
Firestore transport. It covers intended OMNI-shaped membership, legacy email omission,
field preservation, wrong tenants, privileged/malformed records, create/update/delete
races, missing/revoked state, rejected conditions, lost acknowledgements after commit,
bounded/malformed responses, no blind retries and unchanged request/auth/rate gates.
No production account is a test fixture.
The separate eight-case native test exercises the same Commit body/precondition contract
against an installed local emulator; actual helper/router integration uses the synthetic
transport. Neither substitutes for meaningful rules acceptance or production evidence.

Before release, require full tests, lint/build, actual rules emulator, dependency audits,
independent review, normal protected PR gates and exact deployment/source verification.
This preparation does not authorize a Spool admin override or dependencies/security
exceptions. Prefer a forward fix if later actual use relies on these guards; reverting
to the previous receiver reintroduces cross-tenant and race hazards.
