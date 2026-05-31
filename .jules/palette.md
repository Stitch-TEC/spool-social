## 2025-05-15 - [Accessibility for Icon-Only Buttons]
**Learning:** Icon-only buttons in the application often lacked `aria-label` and `title` attributes, making them inaccessible to screen readers and providing no tooltips for sighted users.
**Action:** Always ensure that buttons containing only icons have descriptive `aria-label` and `title` attributes to improve accessibility and user experience.

## 2025-05-16 - [Keyboard Accessibility and Action Feedback]
**Learning:** Elements hidden behind hover states (like action buttons in 'PostCard') are unreachable for keyboard users unless explicitly handled with `group-focus-within`. Additionally, clipboard actions lack immediate visual confirmation, leading to user uncertainty.
**Action:** Implement `group-focus-within:opacity-100` for hover-only actions and add temporary 'Copied!' success states with check icons for better interaction feedback.

## 2026-03-29 - [Mobile Layout and Interaction Optimization]
**Learning:** Dense grid and calendar views often become unusable on small screens due to excessive padding and desktop-centric hover states. Sidebars without backdrops are difficult to dismiss and lack clear focus on mobile.
**Action:** Implement responsive font sizes and spacing (e.g., `text-[10px] sm:text-xs`), use abbreviated headers for mobile (e.g., 'S' vs 'Sun'), ensure action buttons are always visible on touch devices by bypassing hover-only classes, and add semi-transparent backdrop overlays for off-canvas sidebars to enable 'tap-to-close' functionality.

## 2025-05-17 - [Search Clear UX and Focus Management]
**Learning:** When implementing a 'clear' button that conditionally unmounts (e.g., only shows when input is not empty), the browser loses focus if the button was the active element. This disrupts keyboard navigation flow.
**Action:** Use a React 'ref' on the input field and programmatically return focus to it after the clear action to ensure a seamless experience for keyboard users.

## 2025-05-18 - [Accessibility for External Links and Navigation]
**Learning:** Generic labels like "Open App" or "Today" provide insufficient context for screen reader users and lack hover tooltips. Providing descriptive `aria-label` and `title` attributes (e.g., "Open platform app", "Go to Today") significantly improves screen reader navigation and discoverability.
**Action:** Always provide descriptive context-aware ARIA labels and titles for navigational and external link elements.

## 2025-05-19 - [Accessible Dropdowns and Live Regions]
**Learning:** Purely CSS-based dropdowns (e.g., using `group-hover`) are inaccessible to keyboard users unless paired with `group-focus-within`. Additionally, dynamic UI updates like toast notifications are invisible to screen readers unless they use ARIA live regions.
**Action:** Use `group-focus-within` to reveal hidden menus on keyboard focus and ensure toast components have `role="status"` and `aria-live="polite"` for proper announcement.

## 2025-05-20 - [Semantic Progress Indicators and Editor Shortcuts]
**Learning:** Decorative SVG indicators for limits (like character counts) are invisible to screen readers unless they use the 'progressbar' role and appropriate ARIA attributes. Additionally, providing standard keyboard shortcuts (Ctrl+Enter) and visual loading states (spinners) in forms significantly improves the perceived speed and accessibility of the drafting experience.
**Action:** Use 'role="progressbar"' with 'aria-valuenow' for SVG indicators, implement 'Ctrl/Cmd+Enter' shortcuts for textareas, and always provide 'isSaving' feedback for async form submissions.
