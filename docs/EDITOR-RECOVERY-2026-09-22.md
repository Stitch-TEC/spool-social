# Editor recovery and phone controls — September 22, 2026

This release keeps a device recovery copy when an installed app or browser page
goes into the background, including edits made during the 800ms autosave delay.
The normal before-close warning remains. Local recovery does not save the thread
to Spool or change its review stage.

The discard dialog now checks whether device storage actually accepted a copy.
It explains when storage is unavailable or when a new image was omitted from the
snapshot. If that outcome changes while the dialog is open, it shows the revised
message before closing. A failed save keeps the current text and permits retry;
whitespace-only content cannot be submitted. Closing and duplicate submission
are disabled while a save is pending.

The editor header and recovery-banner buttons wrap at phone widths. Synthetic
Chromium and WebKit checks at 320px, 390px and 768px verified visible controls,
recovery, the discard dialog and save-error handling. No live account or content
was used.

Validation: 21 editor cases, 520 ordinary cases, lint, action pins, production
build and dependency audit. Firestore rules are unchanged and their required CI
gate remains in place. Deployment is separately tracked in the suite status.

Known pre-existing limit: typing or an image/AI result can arrive while a save is
pending. The app still closes after the submitted snapshot succeeds. Preserving
newer edits safely, especially for a newly created thread, needs an explicit
saved-identity contract; this release does not change that persistence flow.
