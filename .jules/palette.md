## 2025-05-15 - [Accessibility for Icon-Only Buttons]
**Learning:** Icon-only buttons in the application often lacked `aria-label` and `title` attributes, making them inaccessible to screen readers and providing no tooltips for sighted users.
**Action:** Always ensure that buttons containing only icons have descriptive `aria-label` and `title` attributes to improve accessibility and user experience.

## 2025-05-16 - [Keyboard Accessibility and Action Feedback]
**Learning:** Elements hidden behind hover states (like action buttons in 'PostCard') are unreachable for keyboard users unless explicitly handled with `group-focus-within`. Additionally, clipboard actions lack immediate visual confirmation, leading to user uncertainty.
**Action:** Implement `group-focus-within:opacity-100` for hover-only actions and add temporary 'Copied!' success states with check icons for better interaction feedback.

## 2026-03-29 - [Mobile Layout and Interaction Optimization]
**Learning:** Dense grid and calendar views often become unusable on small screens due to excessive padding and desktop-centric hover states. Sidebars without backdrops are difficult to dismiss and lack clear focus on mobile.
**Action:** Implement responsive font sizes and spacing (e.g., `text-[10px] sm:text-xs`), use abbreviated headers for mobile (e.g., 'S' vs 'Sun'), ensure action buttons are always visible on touch devices by bypassing hover-only classes, and add semi-transparent backdrop overlays for off-canvas sidebars to enable 'tap-to-close' functionality.
