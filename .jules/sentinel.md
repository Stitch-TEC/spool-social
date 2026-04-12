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

## 2025-05-18 - [Input Validation and UI Feedback for Tags]
**Vulnerability:** Potential for database bloat or DoS via unlimited tag creation (count and length).
**Learning:** Security validation must be enforced both at the persistence layer (Firestore handlers) and the UI layer to provide a consistent user experience and prevent bypass.
**Prevention:** Enforce strict limits on array-based inputs (e.g., max 10 tags) and string lengths (e.g., 20 chars per tag) in both 'App.jsx' and 'Editor.jsx'.
