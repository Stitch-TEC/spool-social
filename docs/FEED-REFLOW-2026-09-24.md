# Feed controls and card reflow — September 24, 2026

## Scope

This is a presentation-only follow-up to the mobile header release. It covers
the feed's review chips, facet/sort selects, density switch, card/compact layouts,
grid column sizing and the operator's parked-suggestions notice. It does not
change filters, counts, saved views, data subscriptions, tenant scope, review or
publishing eligibility, callback arguments, writes, auth, rules or Worker code.

## Reproduced problems

The browser fixture uses the actual app/components with invented posts and
blocked production transport. It can replay the preceding source independently
of the working tree. At a 320px viewport with a 200% root-font setting, the old
sort select extended to 438px. Fixed card action rows could also be clipped by
the card while the document itself reported no horizontal overflow; this
occurred even with ordinary-size text on a narrow touch-style compact card.

At 1280px with enlarged root text, the old viewport-only grid still demanded
three cards, leaving full cards about 181px wide as font-relative sidebar/page
padding grew. The parked-suggestions notice also forced its trailing dismissal
button beyond the narrow viewport. These are distinct failures: testing only
document scroll width would miss controls clipped inside a card.

## Changes

- Native selects and their flex wrappers cannot exceed available width. The
  shared toolbar select retains Safari's explicit height plus zero vertical
  padding (`h-11 py-0`), now at least 44px tall. Long selected labels may be
  visually abbreviated by the native closed control; the full option strings,
  active zero-count values and native selection behavior are unchanged.
- Review chips, clear and density controls can wrap. Toolbar controls have
  explicit visible keyboard focus; review/clear controls and density buttons
  have 44px minimum target height (density and clear also minimum width).
  Toolbar foregrounds and count backgrounds use stronger contrast.
- Card metadata/badges can wrap. Touch-style icon actions occupy their own
  wrapping row; fine-pointer actions remain a hover/focus overlay, now bounded
  to the card and allowed to wrap. Those icon buttons have 44px minimum targets.
  Footer action labels can wrap instead of disappearing beyond the card edge.
  Unbroken tags, copy, provenance and feedback can break within their containers.
- Grid sizing retains the previous viewport column caps: full cards at most
  1/2/3/4; compact at most 1/2/3/4/5. A font-relative minimum (18rem for cards,
  17.5rem for compact) reduces columns when those caps would make cards too
  narrow. `auto-fill`, not `auto-fit`, retains empty columns for a short feed.
  Grid gaps remain 1.5rem/1rem; list density and windowing are unchanged.
- The existing suggestions notice wraps its message/actions; Review and
  Dismiss have 44px minimum targets, stronger contrast and visible focus.
  Its operator-only predicate, lane transition, selection reset and
  session-only dismissal are unchanged.

## Deliberate tradeoffs and limits

Cards and toolbars may be taller, and enlarged text can show fewer grid columns.
All previously eligible actions remain available; this does not add actions to
guests, suggestions, templates, archived posts or selection mode. Existing
snippet line clamps, compact tag/readiness caps and full-editor access remain.

This is not a complete feed accessibility certification. List rows still use
their existing interaction model, and some older card-footer/disclosure controls
remain below 44px. The 44px design target is not a blanket WCAG 2.1 AA requirement.
Untouched metadata/brand colors are not certified for contrast. A 200% root-font
fixture is a useful enlarged-text stress case, not a substitute for physical
Safari zoom, iPhone keyboard or VoiceOver testing.

## Verification and release boundary

Component tests preserve full select options, active-value retention, callback
arguments, role gates, card action propagation and review/template/suggestion
separation. The actual-App fixture checks suggestions notice navigation,
selection reset, dismissal and role/lane visibility with all writes blocked.

Native Chromium/WebKit checks must additionally verify computed geometry,
inside-card clipping, normal and enlarged-text column counts, short feeds,
keyboard reachability and the touched contrast/focus states. Unit tests alone
cannot prove CSS geometry. Release is subject to the ordinary full test/build,
independent review, CI and exact-source production verification gates; this
source note does not itself claim a completed deployment.

The suite's private release evidence is retained under
`_archive-2026-09/spool-feed-reflow-20260924/` outside the public app repository.
