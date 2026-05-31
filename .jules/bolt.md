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

## 2026-04-14 - [Search Filtering Redundancy]
**Learning:** Performing `toLowerCase()` on both the search query and multiple fields for every item in an array during a filter pass (O(N)) is computationally expensive and redundant. This overhead grows linearly with the number of posts.
**Action:** Normalize the search query once outside the filter loop and cache lowercase versions of searchable fields (`_searchContent`, `_searchClient`) on data objects when they are first ingested or updated.

## 2026-04-15 - [Granular Props and Custom Memoization for Live Previews]
**Learning:** Components used for "live previews" (like `MobilePreview`) that are children of complex state-heavy parents (like `Editor`) often re-render on every keystroke due to metadata changes (tags, dates) that aren't visually relevant to the preview. Additionally, passing large map objects (like `clientMap`) as a prop forces re-renders if *any* key in the map changes.
**Action:** Use `React.memo` with a custom comparison function to only re-render on visual field changes. Lift expensive lookups (like image resolution and client settings) to the parent and pass only the specific primitive values or stable sub-objects (`clientSettings`) to the child. Use a shared, frozen `DEFAULT_CLIENT_SETTINGS` object to preserve referential stability for missing data.

## 2026-04-28 - [High-Frequency Date Formatting Overhead]
**Learning:** Repeated calls to `toLocaleString()` and `toLocaleTimeString()` in components rendered in large lists (`PostCard`) or dense grids (`CalendarView`) incur significant CPU overhead because the browser re-compiles the formatting pattern on every call.
**Action:** Use shared, pre-compiled `Intl.DateTimeFormat` instances to perform formatting, which is ~50x faster than repeated `toLocaleString()` calls.

## 2026-05-05 - [Redundant State Initialization and Loop Allocations]
**Learning:** Naive state initialization like `useState(new Date())` or creating objects like `new Date()` inside a loop (e.g., in a calendar grid) leads to unnecessary memory allocations and GC pressure on every render.
**Action:** Use lazy state initializers `useState(() => new Date())` for initial values and pre-calculate stable values (like 'today') outside of loops to minimize redundant allocations.

## 2026-05-20 - [Incremental Firestore State Management & View-Aware Computations]
**Learning:** Mapping over an entire Firestore collection snapshot (`snapshot.docs.map()`) on every update results in O(N) complexity for data parsing and object creation. For large collections, this creates significant main-thread lag. Additionally, running filters for non-visible views (e.g., filtering calendar posts while in grid view) wastes CPU cycles.
**Action:** Use `snapshot.docChanges()` to process only added, modified, or removed documents (O(M)), maintaining a local Map to preserve referential stability. Implement view-awareness in expensive `useMemo` hooks to skip processing when the result is not visually required.
## 2026-05-19 - [Referential Stability in Firestore Listeners]
**Learning:** React state updates from Firestore snapshots often create new object references (like Dates) even for unchanged fields. This invalidates `React.memo` for child components down the tree. Additionally, using `.map()` to initialize a Map from the previous state creates unnecessary intermediate array allocations.
**Action:** Implement reference preservation by caching raw values and reusing existing objects if the raw value hasn't changed. Use a simple `forEach` loop for Map initialization to minimize GC pressure.
