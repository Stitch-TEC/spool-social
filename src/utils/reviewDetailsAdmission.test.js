import { describe, expect, it } from 'vitest';
import { assertLegacyReviewSelection } from './reviewDetailsAdmission';

describe('delayed legacy-writer selection admission', () => {
  it('admits the exact current legacy selection without modifying rows', () => {
    const rows = [{ id: 'a', content: 'Legacy' }, { id: 'b', content: 'Other' }];
    const before = JSON.stringify(rows);
    expect(() => assertLegacyReviewSelection(rows, ['a', 'b'])).not.toThrow();
    expect(JSON.stringify(rows)).toBe(before);
  });
  it('refuses a selection that acquired details while confirmation was open', () => {
    expect(() => assertLegacyReviewSelection([{ id: 'a', reviewDetailsVersion: 1 }], ['a']))
      .toThrow('This thread has review details.');
  });
  it.each([['reviewDetailsAck', null], ['reviewDetailsAck', {}], ['reviewMediaLinks', null],
    ['reviewMediaLinks', []], ['reviewMediaLinks', '']])('refuses current ack/alias-only %s presence %#', (field, value) => {
    const rows = [{ id: 'a' }, { id: 'b', [field]: value }];
    expect(() => assertLegacyReviewSelection(rows, ['a'])).not.toThrow();
    expect(() => assertLegacyReviewSelection(rows, ['a', 'b'])).toThrow('review details');
    expect(rows[1][field]).toEqual(value);
  });
  it('refuses a deleted/missing source rather than cloning a stale copy', () => {
    expect(() => assertLegacyReviewSelection([], ['a'])).toThrow('no longer available');
  });
  it('rechecks all remaining rows between chunks', () => {
    const rows = [{ id: 'b' }, { id: 'c' }];
    expect(() => assertLegacyReviewSelection(rows, ['b', 'c'])).not.toThrow();
    rows[1].firstComment = 'New details';
    expect(() => assertLegacyReviewSelection(rows, ['b', 'c'])).toThrow();
  });
  it('does not block an unrelated versioned row outside the selection', () => {
    expect(() => assertLegacyReviewSelection([{ id: 'a' }, { id: 'b', reviewDetailsVersion: 1 }], ['a']))
      .not.toThrow();
  });
});
