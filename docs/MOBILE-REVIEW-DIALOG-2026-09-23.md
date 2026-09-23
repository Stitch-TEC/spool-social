# Mobile review dialog — 2026-09-23

Status: locally tested candidate, pending independent exact-source review and release. This record does not claim deployment.

## Why this change

The review dialog used two stacked flex panes inside a fixed-height, overflow-hidden card. The transformed 300 × 600 phone preview still occupied its unscaled layout space, and the review pane retained its content-sized minimum height. In actual Chromium and WebKit at 320 × 568, the approval button initially started around y=922 for a short invented review and y=17,312 for a long one. Scrolling every naturally scrollable ancestor did not reveal it. At 740 × 320, the long example placed it around y=6,359.

An ordinary automated `click` gave a false pass: it scrolled an `overflow:hidden` ancestor that a person could not scroll normally. The corrected acceptance checks use wheel input and hit testing before any button click. Initial keyboard focus also remained outside the modal.

## Bounded implementation

- Mobile and short screens have one naturally scrollable card. Reading order is header, complete content/metadata/history, the one full image/phone preview, then approval controls.
- A two-column desktop grid is used only when the viewport is at least 48rem wide and 30rem high. The left preview and right content remain independently scrollable, with the header/footer retained. Narrow desktop-height layouts fall back to the single scroller.
- The scaled preview has an explicit layout-sized wrapper. Unbroken content, tags and feedback can wrap rather than widen the dialog. Small-screen action buttons stack; Close and feedback-reason targets have a 44px minimum size.
- The card uses dynamic viewport height when supported, with a `vh` fallback. Initial focus is Close, never Approve. Tab stays within visible enabled dialog controls; Escape retains the existing close callback, and unmount restores the prior connected focus target without scrolling the background. Switching to feedback focuses its heading without automatically opening a phone keyboard.

There is no change to approval/request-changes callbacks, validation or persisted fields, archived guards, authorization, Firestore rules, workers, media parsing, feed reads, dependencies, or the create-recovery journal. The phone preview is not duplicated. ReviewModal remains eagerly loaded; a new loading/failure surface is not justified by a small optional split. Larger initial-load work remains a separate design, not an improvement claimed by this change.

## Acceptance

- 647 application tests pass, including 14 ReviewModal tests (five new lifecycle/order regressions).
- 34 Firestore emulator tests pass separately; no rules source changes.
- Lint, production build, zero-vulnerability audit, and 12 action pins across four workflows pass.
- Actual-component browser matrix: 86 checkpoints pass across Chromium and WebKit, using production CSS and invented data. Scenarios include 320 × 568 short/long content; 740 × 320 and 768 × 320 landscape; 390 × 220 keyboard-height approximation; 1280 × 900 desktop; 200% root text sizing; Instagram/Twitter/blog variants; and archived controls. Assertions cover natural scrolling, image-before-approval order, all approval/feedback buttons, exact feedback callback text, focus wrap/containment, Escape and opener restoration. External requests are rejected, and callbacks only record synthetic values.
- Production build entry is 413.49 kB raw / 125.08 kB gzip versus baseline 411.77 / 124.53. This is a usability/accessibility fix, not a claimed load-time reduction.

Author evidence is retained in the suite archive at `_archive-2026-09/spool-mobile-loading-20260923/`: baseline `browser/before-natural/`, final `browser/grid-verified/`, `browser/verify.mjs`, and the `*-final.log` gates. Frozen-source independent evidence is recorded separately.

## Impact, risk, and release boundary

Impact is limited to people opening Spool's review dialog. No new workflow training is needed beyond explaining that on a phone the preview follows the text and precedes the actions. Release communication should describe reachable mobile controls, not claim that approval policy changed or that all accessibility issues are solved. No new service cost or configuration is introduced.

The primary risk is a browser-specific scrolling/focus interaction. Natural-scroll and keyboard tests cover two browser engines, but they are not physical iPhone/iPad Safari or VoiceOver acceptance. A 220px viewport and 200% root font size are bounded proxies, not an actual software keyboard or browser zoom. Existing muted-label contrast and broader app modal/background-scroll behavior remain outside this targeted review; this is not a WCAG conformance certification. Native Safari rechecking remains useful after release.

Before release: require an independent source review and the normal protected CI gates, then use the ordinary reviewed app release process. Do not deploy rules, change credentials, or perform test approvals on real records for this stage. Confirm the deployed asset/source identity and public loading without client writes.

If a regression traps focus, hides controls, or prevents ordinary review, revert this bounded component/test change in a reviewed source commit and release the prior-compatible app build. There is no data rollback or migration. The previous layout's known mobile limitation would return, so a narrow fix-forward is preferable when practical. Verify Close, natural scrolling, both feedback/approval controls, and archived denial after any rollback or follow-up.
