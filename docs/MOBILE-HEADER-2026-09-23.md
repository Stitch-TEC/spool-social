# Mobile header reflow — 2026-09-23

## Scope

This small interface change keeps Spool's existing header actions usable on a
narrow screen. No authentication, role eligibility, search/filter logic, saved
views, review actions, post data, Firestore rules, Worker code, API, dependencies
or deployment configuration changes are included.

The prior single fixed-height row made the real App wider than its viewport:
independent synthetic browser checks measured a 448px document at 320px and
390px, with controls outside the visible screen. Existing medium-width layouts
also overflowed when branding, account information and Share text became visible.

## Layout and accessibility adjustments

- Keep the existing DOM order: app launcher/sidebar/branding, search, actions.
  The header now wraps with its content. Search has a useful minimum width and
  takes another row when space or enlarged text requires it; actions use their
  own row below 1536px and may share the row above it when they actually fit.
  Nothing is hidden with overflow clipping and no resize observer is added.
- Keep the app header sticky in taller windows, but let it scroll normally in
  short viewports (height at most 40rem / ordinarily 640px). With 200% root text,
  a 449px header in a 320px-high window otherwise covers the feed throughout a
  scroll. The short-height fallback keeps every control and the feed reachable
  without clipping or capping the header's height. A 512px cutoff was insufficient:
  at 320×520 with 200% root text and a long selected client, the header reached
  537px and still covered the feed. The 640px fallback addresses the tested
  320px-and-wider, up-to-200%-root-text cases; it is not a guarantee for arbitrary
  zoom levels or untested browser accessibility settings.
- Remove sticky positioning from post-group
  headings at **all** widths. Group labels, counts and sort order are unchanged.
  This is an intentional desktop tradeoff: a fixed 64px group offset would be
  wrong whenever the header wraps. An initial desktop fixed-row candidate also
  overlapped controls with 200% root text and the enlarged sidebar, so it was
  replaced with natural all-width reflow rather than assuming a viewport width
  guarantees enough room.
- Header buttons, search and the whole branding link have a minimum 44px target.
  Search clear still returns focus to search; `/` still focuses search only
  outside editable fields and without modifier keys. Visible focus indicators
  and darker text/icon colors improve these specific header controls.
- Grid/Calendar report their selected state. Share has an explicit, complete
  accessible name and tooltip even when the long visible client name truncates.
  Guest/operator/client-admin controls keep their prior eligibility and callbacks.
- The app launcher retains the canonical destinations and link targets. It now
  reports expanded state, associates its button with the disclosed panel and
  marks the current app. Escape returns focus from an open panel to its trigger;
  it does not steal focus after the user moves outside. The panel is width-bounded
  and vertically scrollable on short screens. This remains a disclosure of normal
  links, not an ARIA menu with an unimplemented menu-keyboard contract.

## Verification and limits

Focused component tests cover control callbacks, role gates, original search
behavior, complete Share labeling, launcher disclosure/dismissal/focus and
destinations, plus unchanged group counts and the explicit nonsticky heading
contract. CSS class assertions are guardrails, **not** a substitute for layout
proof. The stage's independent Chromium/WebKit harness renders the real App with
production CSS and synthetic auth/feed/roster boundaries; its before/after
records, geometry/keyboard/scroll results and source hashes live under the suite
archive `_archive-2026-09/spool-mobile-header-20260923/`.

Browser checks do not establish physical iPhone behavior, VoiceOver coverage or
a complete WCAG audit. The 200% root-font proxy tests a deliberate enlarged-text
layout edge case, not every operating-system accessibility setting. Other legacy
toolbars, cards and unrelated app dialogs remain outside this header-only slice.
No client data was needed for the tests, and no action dispatch semantics change.
