## 2025-05-15 - [Calendar View O(N*D) Bottleneck]
**Learning:** In the `CalendarView` component, posts were being filtered for every single day of the month inside the render loop. With ~30 days in a month, this results in O(30 * N) operations on every render of the calendar. This is inefficient as N (number of posts) grows.
**Action:** Pre-group posts by date in a single O(N) pass using `useMemo` before rendering the calendar grid.

## 2026-03-26 - [Memoization Effectiveness with Large State Objects]
**Learning:** Passing a large state object (like `mediaMap`) as a prop to many memoized child components (like `PostCard`) causes all children to re-render whenever the object reference changes, even if the specific data the child needs hasn't changed.
**Action:** Resolve the specific value needed from the map in the parent component and pass only that primitive value (or a stable sub-object) to the memoized child.
