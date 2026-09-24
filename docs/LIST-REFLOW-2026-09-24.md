# List-row reflow and keyboard opening — September 24, 2026

This is the bounded List-density follow-up to the card/toolbar release described
in `FEED-REFLOW-2026-09-24.md`. Runtime changes are confined to `PostRow.jsx`.
There is no App, grid/windowing, filter, query, subscription, auth/rules, Worker,
dependency, configuration or writer change.

## Reproduced problem

The preceding row put its preview, fixed-width metadata and actions into one
non-wrapping line. At 200% root text, rich rows could reduce the preview to zero
width and push actions beyond the row's clipping boundary. The fixed 126px date
slot could contain approximately 189px/218px of date text in Chromium/WebKit,
overlapping the preceding column. Document scroll width alone did not reveal
these internal losses. The preceding card/toolbar release explicitly retained
these List defects rather than claiming to fix them.

## What changes

- The row, action cluster and secondary-action subgroup can wrap. The preview
  has a font-relative flex basis so metadata cannot reduce it to nothing merely
  to preserve a single line. The existing one-line preview/ellipsis is retained;
  opening the editor remains how the operator reads all copy.
- Date width is now 7.875rem (126px at the ordinary 16px root size), capped by
  available space. Text may wrap inside that slot; it no longer uses nowrap
  text wider than a fixed physical-pixel column. The clock icon does not shrink.
- Static and editable status slots share a 5.5rem width. Native selects have an
  explicit `h-11`, minimum 44px height and zero vertical padding for Safari.
  Existing status option values, order and member restrictions are unchanged.
- Row buttons have minimum 44px targets and explicit visible focus. Dates,
  default action icons, relevant badge/status text and the empty preview use
  stronger foregrounds. Waiting-day counts retain their number and inherit the
  badge's full foreground instead of weakening it with opacity.
- The preview is now a native `type="button"` sibling to metadata, status and
  actions. It calls the same existing row-open/selection callback, stops its
  own click from bubbling to that row a second time, and uses native Enter/Space
  activation. There is no button wrapped around other buttons or selects, no
  outer button role and no custom keyboard event emulation. Clicking row
  whitespace still performs the existing row action.
- In selection mode the preview's pressed state announces whether the row is
  selected. Its accessible name identifies Open/Select plus a bounded 120-character
  normalized title or nonblank content preview, with an empty-draft fallback.
  Visible content is not rewritten or truncated in storage.

## Preserved boundaries

All action-eligibility predicates and callback arguments are unchanged: staged
send, changes-requested resubmit, archived restore/no-review actions, member
status restrictions, suggestion promote/dismiss and template use remain separate.
Sibling buttons/status changes retain stop-propagation and do not accidentally
open or select the row. Selection mode does not silently change their existing
eligibility. This does not execute or alter any send, approval or persistence
operation.

Existing responsive visibility is retained, including narrow-screen secondary
action hiding and metadata breakpoints. No action that was visible at a given
viewport is newly hidden to make the row fit. Existing fine-pointer hover/focus
reveal and touch visibility remain. Review guests are still pinned to Cards by
the unchanged parent; this does not give guests a List shortcut.

## Deliberate tradeoffs and limits

Normal rows remain compact where the contents fit, but 44px targets and wrapping
mean rows are no longer promised to be about 48px tall. Large text/rich rows can
use multiple lines. Metadata alignment may differ once a row wraps. No fixed-height
virtualization or measurement observer was added; the existing feed windowing
already accommodates natural height.

The 44px goal applies to row controls, not every legacy control elsewhere in the
app, and is not a blanket WCAG 2.1 AA requirement. User-supplied brand colors,
platform graphics and unrelated screens are not certified by this change.
Shortened accessible names and visual previews are navigation cues, not a
replacement for reading the full draft. Root-font enlargement and desktop
WebKit are useful stress cases, not physical-device/native-zoom/VoiceOver proof.

## Verification and release boundary

Unit tests cover native button semantics/names, selection-only pressed state,
single callback dispatch, retained whitespace clicks, status/secondary/review
actions during selection, template/suggestion separation and the explicit
layout class contracts. Existing PostGrid tests retain the guest-density and
windowing checks.

Native Chromium/WebKit acceptance must separately measure preview width, every
visible control's bounds and overlap, date text ink inside its own slot, select
text space, normal/rich/enlarged layouts, keyboard Enter/Space and sibling-action
isolation. Native geometry cannot be proven by jsdom class assertions alone.
Full tests, independent review, hosted CI and exact-source live-byte verification
remain release gates. This source note itself does not assert deployment.

Private release/QA evidence belongs in the suite's
`_archive-2026-09/spool-list-reflow-20260924/` directory, not the public app repo.
