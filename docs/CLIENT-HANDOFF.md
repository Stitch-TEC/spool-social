# Client-view navigation from POM

September 27, 2026 — receiver implementation; release requires a reviewed Spool PR.

## Contract

`https://spool.stitchtec.dev/?clientSlug=<canonical-slug>` is a **navigation hint for an already
authorized operator**, not a sign-in token, access grant, sharing link or workspace impersonation.
POM must deploy outgoing links only after this receiver is merged, deployed and verified live.
Keep global app-switcher links generic. Sender has a separate session/workspace contract and is not
part of this change.

The new link accepts one canonical lowercase-hyphenated `clientSlug` parameter, up to 128 characters.
Duplicate, malformed, mixed `client` and extra-parameter handoffs are rejected with a manual fallback.
Presence of existing `s` or `uid` review parameters leaves the established review lane in charge;
this parser does not change their authentication semantics. Ordinary legacy `?client=` still means
a display name. Never put a slug in that legacy parameter.

Interactive callers must be operators; the existing internal API-key path is unchanged. The existing `GET /api/clients` route gains opt-in
`?handoff=1` after its existing authentication, operator and rate-limit checks. A strict response is
HTTP200 `{ok:true,confirmed:true,clients:[...]}` with `Cache-Control: no-store`; upstream verification failure is a fixed
503, never a fabricated empty success. Legacy callers retain their existing fail-open response.
The server requires broker `source:firestore`, complete valid eligible rows and a bounded body/read.
The broker can cache the eligible roster for 60 seconds and excludes internal clients. `confirmed`
does not mean a new direct Firestore read, an unfiltered roster or authoritative absence.

## Selection and lifetime

The browser bounds token retrieval and roster transport/body reads separately at 15 seconds each.
It pins the exact current SDK user and observed auth revision; the roster hook also owns its project/
UID/revision lifetime. Background refresh invalidates confirmation. No second roster is persisted.

The receiver resolves one exact slug to an unambiguous current name, refuses archived targets, and
checks the loaded post/branding names for conflicting client IDs. It waits for the existing posts
read, refuses its failure, and rejects selected labels incompatible with the current draft sanitizer.
An unresolved link never displays the ordinary feed or provides a raw slug to editor/media defaults.
Errors and changed names require deliberate revalidation after a successful check. A changed account,
role or observed auth revision retires the link rather than reapplying it to the next session.

The intent ends when the operator explicitly chooses another client, continues without the link,
applies a saved view, or opens an editor (New, Open, Use as draft, New template) or workspace tool
(brand settings, media, import/export, sharing, administration, automations). Tool/editor entry checks
and consumes the current selection synchronously, then carries its name into the ordinary manual
workflow. Same-tick stale/double entry cannot reopen it. Later roster refreshes cannot replay the
link or unmount unsaved editor work. The URL remains a navigation hint if deliberately reloaded.

Messages contain fixed explanations, not raw provider errors or unverified query values. Recovery
buttons have visible focus and 44px minimum targets. Explicit Continue/Open verified client restores
focus to the destination only when that action still owns focus.

## Scope and limitations

This does not migrate posts, rename clients, repair historical labels, add grants, submit drafts,
send review invitations, fetch media, change providers, rules, storage or billing. It does not alter
ordinary editor/media writer identity resolution after an operator deliberately enters that workflow.
That broader canonical-ID cleanup remains a separate reviewed task.

The current feed filters by display name. Old differently named drafts may be outside the selected
view; the banner provides an explicit Show all clients action and explanation. Missing legacy IDs,
off-roster historical name collisions and not-yet-loaded branding are not proven safe by this check.
The existing initial auth loader is outside the new roster deadline. Completely unobserved SDK-only
account round trips are not claimed solved. Tests use synthetic accounts and transport; no physical
iPhone, VoiceOver certification or authenticated production mutation is implied.

## Release and recovery

Test parser/resolver, strict transport, Worker auth/projection/failure, session retirement, all four
editor entry points, legacy share/member behavior, mobile reflow, keyboard focus and no-write behavior.
Run full lint/application/rules/build/audit/action-pin checks and independent review before merging.
Then verify the exact deployed Worker and public app artifacts before enabling POM links. No schema
or rule deployment accompanies this feature. Keep branch protections and held work unchanged.

For a regression, use a narrow reviewed fix-forward or source revert through the protected pipeline.
If POM links have subsequently shipped, revert those sending links before rolling back the receiver.
Do not clear recovery storage, alter client data/access, or retry uncertain saves to compensate.
