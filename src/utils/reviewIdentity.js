/**
 * Canonical scheduling identity shared by browser and Worker review CAS paths.
 * usePosts exposes scheduledDate as a Date while Firestore REST returns the raw
 * ISO string; both must identify the same review state. Invalid non-empty
 * values throw so a malformed schedule can never be silently approved.
 */
export function canonicalReviewScheduledDate(value) {
  if (value === undefined || value === null || value === '') return '';

  let date;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === 'string') {
    // Date.parse accepts many locale-dependent shapes. The stored review
    // contract is ISO, so require an explicit UTC/offset timestamp first.
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/);
    const year = Number(match?.[1]);
    const month = Number(match?.[2]);
    const day = Number(match?.[3]);
    const hour = Number(match?.[4]);
    const minute = Number(match?.[5]);
    const second = Number(match?.[6]);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (!match || year < 1 || month < 1 || month > 12
      || day < 1 || day > daysInMonth[month - 1]
      || hour > 23 || minute > 59 || second > 59) {
      throw Object.assign(new Error('scheduledDate is not a valid ISO timestamp'), {
        code: 'review_date_invalid',
      });
    }
    date = new Date(value);
  } else if (typeof value === 'object' && typeof value.toDate === 'function') {
    try { date = value.toDate(); }
    catch { date = null; }
  } else if (
    typeof value === 'object'
    && Number.isSafeInteger(value.seconds)
    && Number.isSafeInteger(value.nanoseconds)
    && value.nanoseconds >= 0
    && value.nanoseconds < 1_000_000_000
  ) {
    date = new Date((value.seconds * 1000) + Math.floor(value.nanoseconds / 1_000_000));
  }

  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw Object.assign(new Error('scheduledDate is invalid'), { code: 'review_date_invalid' });
  }
  return date.toISOString();
}

/** Shape a Firestore schedule for usePosts without passing Timestamp objects
 * through Date's implementation-dependent object coercion. */
export function reviewScheduledDateAsDate(value) {
  const canonical = canonicalReviewScheduledDate(value);
  return canonical ? new Date(canonical) : null;
}
