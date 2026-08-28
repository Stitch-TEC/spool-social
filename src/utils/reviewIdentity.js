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

// `datetime-local` deliberately has no timezone. Older Spool saves persisted
// that exact browser value (`YYYY-MM-DDTHH:mm`) before the review CAS contract
// required zoned ISO timestamps. Those rows are valid display input in the
// operator's local timezone. The strict canonical timestamp API remains
// fail-closed; the dedicated conflict token below binds this legacy shape as
// exact bytes without pretending it identifies an absolute instant.
function legacyLocalScheduledDateParts(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
  if (!match) return null;

  const [, rawYear, rawMonth, rawDay, rawHour, rawMinute, rawSecond = '0', rawMs = '0'] = match;
  const [year, month, day, hour, minute, second] = [
    rawYear, rawMonth, rawDay, rawHour, rawMinute, rawSecond,
  ].map(Number);
  const millisecond = Number(rawMs.padEnd(3, '0'));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12
    || day < 1 || day > daysInMonth[month - 1]
    || hour > 23 || minute > 59 || second > 59) return null;
  return { year, month, day, hour, minute, second, millisecond };
}

function legacyLocalScheduledDateAsDate(value) {
  const parts = legacyLocalScheduledDateParts(value);
  if (!parts) return null;
  const { year, month, day, hour, minute, second, millisecond } = parts;
  const date = new Date(year, month - 1, day, hour, minute, second, millisecond);

  // Date's constructor normalizes impossible dates and DST gaps. Reject those
  // instead of silently displaying a different schedule.
  if (!Number.isFinite(date.getTime())
    || date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
    || date.getHours() !== hour
    || date.getMinutes() !== minute
    || date.getSeconds() !== second
    || date.getMilliseconds() !== millisecond) return null;
  return date;
}

/**
 * Read-path conversion for the workspace UI. It accepts the exact legacy
 * datetime-local shape and degrades malformed stored values to "No date set"
 * so one bad row cannot take down the signed-in feed. Approval/CAS code must
 * use reviewScheduledDateIdentity so legacy rows stay byte-bound while new
 * zoned timestamps remain canonically comparable.
 */
export function displayReviewScheduledDateAsDate(value) {
  try {
    return reviewScheduledDateAsDate(value);
  } catch {
    return legacyLocalScheduledDateAsDate(value);
  }
}

/**
 * Conflict-detection token for old Editor rows. Zoned values still canonicalize
 * to an instant; a valid legacy local value is bound byte-for-byte instead.
 * This preserves stale-action detection without relaxing the strict canonical
 * timestamp API or guessing a timezone in a review transaction.
 */
export function reviewScheduledDateIdentity(value) {
  try {
    return canonicalReviewScheduledDate(value);
  } catch (error) {
    if (legacyLocalScheduledDateParts(value)) return `legacy-local:${value}`;
    throw error;
  }
}

/** Convert Editor output to the zoned ISO storage contract on every new save. */
export function reviewScheduledDateForStorage(value) {
  if (value === undefined || value === null || value === '') return null;
  const local = legacyLocalScheduledDateAsDate(value);
  if (local) return local.toISOString();
  return canonicalReviewScheduledDate(value);
}
