# Client brand settings: late-result safety

Status: implemented and locally tested; independent review and release are separate gates.

## Why

Two ordinary settings-panel races existed on main `02a794b9`:

- A logo upload/drop begun for one client could finish after switching clients and become the other client's logo.
- Settings stayed editable after Save. Its eventual success closed the window even if those newer edits were never sent. Closing and reopening settings while a save was pending also let the old completion close the new window.

These were reproduced with the actual React component, synthetic data, deferred image processing and mocked Firestore writes in jsdom. No real client settings were read or changed.

## Behavior

- Only the latest logo request in the current client/form can change the preview. Switching clients (including away and back), removing the logo, changing a manually entered new-client name, or closing invalidates pending results. A logo already displayed remains when editing the new-client name; only unfinished processing is canceled.
- Save waits for logo processing. A processing failure explains how to retry; stale failures do not show an alert for another client.
- During Save, the settings fields, client picker and rename/merge controls are disabled. The snapshot being sent cannot silently diverge from editable fields. Close and Escape stay available, including if Firestore remains pending offline.
- Closing does **not** cancel a submitted Firestore write. The window says so. Later completion/failure cannot close or change another modal instance.
- A current save failure retains editable values and offers explicit retry. It says the save was not confirmed, rather than claiming nothing could have reached storage.
- Changes to the supplied `uid` or read-only permission start a fresh form and invalidate the old form's UI callbacks.

## Boundaries

This is local UI request ownership, not a new authentication or tenant authorization mechanism. The parent still supplies the shared operator workspace UID; Firebase identity/rules and the existing branding document resolver remain authoritative. The saved payload, merge behavior, client IDs, image-processing implementation and rename/merge business behavior are unchanged.

No editor/recovery (#119), AI/provider, Worker, dependency, rule, schema, publishing or automation changes. No retry/outbox guarantee, pending-write cancellation, cross-window write ordering or local durable recovery was added to brand settings. Close deliberately abandons unsent local settings edits; there is no new discard confirmation. Existing posts and branding storage formats remain unchanged.

## Acceptance

- 17 actual-component regression cases: selected-client payload, upload/drop switching, A→B→A, latest-wins and stale failure, removal, same-file retry, closed/unmounted callbacks, pending-save controls, failed-save retry, new-client naming, `uid` and read-only changes.
- Complete app suite: 642 tests passed. The ordinary run skips the 34 rule tests; those separately passed against a local synthetic Firestore emulator.
- Lint, production build, action-pin check and dependency audit passed (0 reported vulnerabilities).
- Real Chromium and WebKit: 5 synthetic panel scenarios each, including native disabled controls and Close/Escape, late save success/failure after reopen, current-error retry, and layout at 320px. Screenshots reviewed. Browser image processing and persistence were mocked; all non-local network requests were blocked. This is not physical iPhone or production acceptance.

Replay: `npm test -- src/components/ClientSettingsModal.test.jsx`; full gates follow `CLAUDE.md`/repo instructions. Suite-local before-fix proof, browser harness/results and gate logs live in `_archive-2026-09/spool-everyday-next-20260923/`.

## Rollback / support

If this panel regresses, revert this bounded change through a reviewed PR and redeploy the app's normal build. No data migration, rules deployment or settings cleanup is needed. Preserve #119 and all existing recovery records. Confirm the public app and settings lazy asset match the released build, then recheck opening, selecting and saving settings. Do not tell an operator a pending save was canceled just because the window closed.

For the operator: saving temporarily pauses editing; close remains available. If confirmation fails or a pending window was closed, reopen and check the selected client's settings before retrying. No client notifications or training campaign are needed for this internal-only panel.
