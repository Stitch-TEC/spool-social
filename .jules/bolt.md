## 2025-05-15 - [Calendar View O(N*D) Bottleneck]
**Learning:** In the `CalendarView` component, posts were being filtered for every single day of the month inside the render loop. With ~30 days in a month, this results in O(30 * N) operations on every render of the calendar. This is inefficient as N (number of posts) grows.
**Action:** Pre-group posts by date in a single O(N) pass using `useMemo` before rendering the calendar grid.
