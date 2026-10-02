# Separate review media and first comments

Status: compatibility foundation prepared October 2, 2026. Authoring is disabled. This is not the editor-feature release or a Firestore rules deployment.

## Product direction

Keep publishable caption, first comment and review-only media separate. Review links let a person open a video beside a draft without inserting that URL into the caption. First comments need explicit destination support; never append them to captions automatically. Existing caption links are not moved or removed.

## Version 1 contract

| Field | Contract |
| --- | --- |
| `reviewDetailsVersion` | Integer `1`, required when either optional field is present. Sticky even after fields are cleared. |
| `reviewMedia` | Optional ordered list of up to five exact `{id, url, label, version}` objects. IDs are 20–80 ASCII letters/digits/underscore/hyphen; labels at most 120 characters; source-version notes at most 80. Canonical supported HTTPS video references, at most 4,096 characters; no duplicate IDs/URLs, unknown keys or silent truncation. |
| `firstComment` | Optional plain text, at most 4,000 JavaScript string units. This is an application limit, not an asserted platform limit. |
| Browser `reviewDetailsAck` | Exact `{version:1, firstComment, reviewMedia}` snapshot the person actually saw. Empty defaults appear only in this explicit acknowledgement, not in stored legacy rows. |
| Stored `reviewDetailsAck` | The same snapshot plus server `at`, bound to that fresh decision's `reviewedAt`/`updatedAt`. Historical acknowledgements are retained, not substituted for new consent. |

Absence remains absence. Payload and review identities add a versioned extension only for marked rows; legacy identities are unchanged. Linked files can change externally. Approval covers the saved references/comment, not immutable video bytes, playback or destination access. No external metadata fetch or embed is introduced.

## Foundation safeguards

- Recovery uses the same database, tenant scope and reserved ID, with native database version 2. Old recovery records are not rewritten. Comment/link-only work is meaningful; interrupted saves require exact acknowledgement and preserve newer edits separately.
- Worker reads/projections retain and validate the fields. Review actions compare the observed acknowledgement on every retry. New extension authoring through create/update APIs is explicitly refused.
- POM's full preview can show separate links/comment and sends only its frozen observed acknowledgement through the broker. The broker refuses silent authoring requests and stale successful acknowledgements.
- Direct Spool editing/review, import, CSV export and unsupported Sender/site handoffs refuse marked rows rather than strip unseen details. JSON backup preserves raw fields; importing them is not enabled.
- Delayed clone/delete confirmations recheck the loaded selection. These are page-memory checks, not locks or proof against server races, old apps or every secondary writer.

## Activation gates — separate next stage

Do not enable new persisted fields until all of these pass:

1. Reconfirm the actual deployed rules baseline. The October 2 read-only console copy matched historical `firestore.rules` at `9e1e88db` exactly; the current repository rules include separately held changes and are not that deployed baseline.
2. Build the narrow permission overlay on that deployed baseline, excluding held account/grant changes. Test legacy rows, member/operator/guest paths, tenant immutability, unknown markers, field loss, stale consent, deletes and expression budgets against native rules/REST.
3. Inventory every writer: editor, recovery, direct review, import, duplicate/clone, repurpose, bulk/archive/delete, rename/merge and automation. Enforce the common boundary in rules as well as application code. API service-account writers must enforce it independently.
4. Add concise editor controls, full Spool/guest previews and approval-reset behavior, then verify provider-neutral media library selection and empty/cleared fields.
5. Keep unsupported publishing/export destinations refused until separately implemented. Establish a forward-compatible recovery plan, exact source review, protected checks and live byte/config verification before activation.

No real draft, date, grant, provider file, billing record, email, credential, schedule or held activation is a test fixture.

## Release and recovery

Compatibility readers/gates may ship while authoring remains off and deployed rules are unchanged. Release POM, the narrow broker line and Spool only after their exact-source gates pass. Never deploy held broker main or activate unrelated rules by deploying the complete repository configuration.

Once a device opens native recovery version 2, a version-1-only source rollback is incompatible. Preserve version-2 readers/writers in a forward fix; do not clear device recovery, rename its database or mint replacement IDs. An already-claimed old request may still complete: the fence is not cancellation. If new metadata is ever persisted later, do not roll back to unaware approval/projection code; hold writes and forward-fix instead.

Source tests and synthetic browser cases are not authenticated-client, physical-device or PWA acceptance. The October 2 signed-in production check observed the existing operator feed and Help only; it changed no content and does not prove this candidate is live.
