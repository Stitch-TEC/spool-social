## 2025-05-15 - [Calendar View O(N*D) Bottleneck]
**Learning:** In the `CalendarView` component, posts were being filtered for every single day of the month inside the render loop. With ~30 days in a month, this results in O(30 * N) operations on every render of the calendar. This is inefficient as N (number of posts) grows.
**Action:** Pre-group posts by date in a single O(N) pass using `useMemo` before rendering the calendar grid.

## 2026-03-26 - [Memoization Effectiveness with Large State Objects]
**Learning:** Passing a large state object (like `mediaMap`) as a prop to many memoized child components (like `PostCard`) causes all children to re-render whenever the object reference changes, even if the specific data the child needs hasn't changed.
**Action:** Resolve the specific value needed from the map in the parent component and pass only that primitive value (or a stable sub-object) to the memoized child.

## 2026-03-27 - [Efficient Firestore Listener and Bulk Operations]
**Learning:** Iterating over all documents in a Firestore `onSnapshot` listener to update local state (like `mediaMap`) becomes increasingly expensive as the collection grows (O(N)). Additionally, performing multiple sequential `addDoc` calls for bulk operations (like cloning) results in unnecessary network round-trips.
**Action:** Use `snapshot.docChanges()` to only process modified documents (O(M)) and utilize `writeBatch` for atomic, efficient bulk writes.

## 2026-03-28 - [Referential Stability for Global Arrays]
**Learning:** Derived arrays (like `uniqueClients` from `posts`) are recreated on every render if defined naively in `useMemo`. When these arrays are dependencies for other callbacks (like `handleCloneToAll`), those callbacks also change, breaking `React.memo` for all child components.
**Action:** Stabilize the array reference using a string hash (e.g., `join('\0')`) as the `useMemo` dependency, ensuring the array reference only changes when its contents actually change.
