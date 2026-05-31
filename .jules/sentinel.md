## 2025-05-15 - [Defense in Depth: Authorization and Input Validation]
**Vulnerability:** Authorization bypass in event handlers and lack of input validation/sanitization.
**Learning:** Even when the UI hides actions from unauthorized users (like guests in read-only mode), the underlying event handlers must still enforce those restrictions to prevent exploitation via the console or manipulated state. Additionally, missing input length limits on certain fields (like client names) poses a minor DoS risk and data integrity issue.
**Prevention:** Always verify authorization state (e.g., `isReadOnly` flag) at the start of all sensitive action handlers, not just in the UI rendering logic. Implement input sanitization and length validation on all user-controlled fields before persisting to the database.

## 2025-05-16 - [Granular Authorization and Input Limits in Review Workflow]
**Vulnerability:** Guests were previously blocked from all status changes, including approvals, and the feedback field lacked length limits.
**Learning:** Security policies should be granular. Completely blocking guests prevents the app's primary "approval" function. Feedback fields are also a vector for storage-based DoS or DB bloat if they don't have limits.
**Prevention:** Refine authorization to allow specific, intended state transitions for guest users (e.g., `DRAFT` to `SCHEDULED` for approval). Enforce strict character limits (e.g., 500 chars) and sanitization on all feedback/comment inputs.

## 2025-05-17 - [Mass Assignment Prevention in Bulk Imports]
**Vulnerability:** Mass assignment risk in CSV import logic via object spreading (`...item`).
**Learning:** Spread operators are convenient but dangerous when handling user-provided data for database persistence. They can allow injection of arbitrary fields (e.g., overriding `uid`, `status`, or adding non-existent metadata) that bypass validation.
**Prevention:** Always use explicit field mapping and sanitization (trimming and slicing for length limits) when persisting data from external files or multi-field forms, especially in `writeBatch` operations.

## 2026-04-19 - [Mass Assignment and Strict Input Validation]
**Vulnerability:** Mass assignment risk in persistence logic and lack of strict input limits on tags and client names.
**Learning:** Using explicit field mapping instead of object spreading for Firestore updates prevents unauthorized field injection. Input validation should be enforced both at the UI level (attributes, state) and the logic level (sanitization, guard clauses) for defense-in-depth.
**Prevention:** Always use explicit field mapping for DB persistence. Enforce strict character and count limits (e.g., 50 chars for names, 10 tags per post) in handlers.

## 2026-04-26 - [Mass Assignment and Internal State Leaks]
**Vulnerability:** Mass assignment risk in cloning logic and internal field leakage to Firestore.
**Learning:** Using object spreading (`...post`) during document duplication can inadvertently persist internal UI-only helper fields (like `_searchContent` or `_searchClient`) and bypass intent by copying fields like `feedback` or `status` that should be reset.
**Prevention:** Strictly use explicit field mapping for all Firestore write operations, especially when duplicating existing records. Reset lifecycle fields (status, feedback) and owner-related fields (uid) to ensure data integrity and security.

## 2026-05-18 - [Defense-in-Depth for Guest Authorization]
**Vulnerability:** Authorization relies on URL params which can be manipulated; guest actions (approval/feedback) were not verified against the actual visible dataset.
**Learning:** Even when Firestore rules or queries limit initial data, application-level handlers should verify that the requested document ID exists within the user's authorized "view" (stored in a stable ref) to prevent unauthorized modifications via direct function calls or state manipulation.
**Prevention:** Use a stable reference synchronized with the authorized data state to validate document ownership/visibility in all state-changing callbacks.

## 2026-05-25 - [Insecure Mock User Fallback in Production Path]
**Vulnerability:** Hardcoded mock user credentials were used as a fallback in the `onAuthStateChanged` listener.
**Learning:** Hardcoding test or mock users directly in the application's authentication flow can inadvertently grant unauthorized access to anyone if authentication fails or is bypassed. Test-only code should be kept separate from production builds and should never be part of the main application logic unless strictly gated by environment variables.
**Prevention:** Remove all mock user credentials from production code. Use environment-specific authentication mocks or dedicated testing environments to verify functionality without compromising security.
