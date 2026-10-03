import { describe, expect, it } from 'vitest';
import { canonicalBulkTags, mergeBulkTags, parseBulkTags } from './bulkTags';
import { TAG_LIMIT, TAG_LENGTH_LIMIT } from './editorInputs';

const tenTags = () => Array.from({ length: TAG_LIMIT }, (_, index) => `${index}${'a'.repeat(TAG_LENGTH_LIMIT - 1)}`);

describe('bulk tag parsing', () => {
  it('accepts complete exact-limit text longer than the old 200-character input cap', () => {
    const tags = tenTags();
    expect(tags.join(',').length).toBe(209);
    expect(parseBulkTags(tags.join(','))).toEqual(tags);
  });
  it('accepts commas or pipes, outer whitespace and one leading hash', () => {
    expect(parseBulkTags(' , #first | second,, | # third | ##fourth, ')).toEqual(['first', 'second', 'third', '#fourth']);
  });
  it.each(['', ' , | ,, ', ' # | '])('returns no tags for empty input %j', text => {
    expect(parseBulkTags(text)).toEqual([]);
  });
  it.each([
    ['a'.repeat(21), '1–20'],
    [Array.from({ length: 11 }, (_, index) => `tag${index}`).join(','), '10 tags'],
    ['first, #first', 'duplicate'],
    ['first| first ', 'duplicate'],
  ])('rejects the complete invalid input %j without shortening it', (text, message) => {
    expect(() => parseBulkTags(text)).toThrow(message);
  });
  it.each([null, undefined, 2, [], {}])('refuses non-text input %j', value => {
    expect(() => parseBulkTags(value)).toThrow();
  });
});

describe('canonical stored tags', () => {
  it('returns an unchanged copy without mutating the saved array', () => {
    const tags = ['first', '#second', 'Third'];
    const canonical = canonicalBulkTags(tags);
    expect(canonical).toEqual(tags);
    expect(canonical).not.toBe(tags);
    expect(canonicalBulkTags([])).toEqual([]);
  });
  it.each([undefined, null, 'first', {}, [' first'], ['first '], ['first', 'first'], [''], [2], ['a'.repeat(21)], Array(11).fill('first')])('refuses invalid or drifted stored tags %j', value => {
    expect(() => canonicalBulkTags(value)).toThrow();
  });
});

describe('bulk tag merging', () => {
  it('adds an ordered union, preserving existing tags and input arrays', () => {
    const current = Object.freeze(['first', 'Second']);
    const incoming = Object.freeze(['Second', 'third', 'first']);
    expect(mergeBulkTags(current, incoming, 'add')).toEqual(['first', 'Second', 'third']);
    expect(current).toEqual(['first', 'Second']);
    expect(incoming).toEqual(['Second', 'third', 'first']);
  });
  it('removes exact matches only and preserves the order of survivors', () => {
    expect(mergeBulkTags(['First', 'first', '#first', 'second'], ['first', 'unknown'], 'remove')).toEqual(['First', '#first', 'second']);
  });
  it('allows overlap at the limit but rejects any new tag beyond it', () => {
    const current = tenTags();
    expect(mergeBulkTags(current, [current[0]], 'add')).toEqual(current);
    expect(() => mergeBulkTags(current, ['new'], 'add')).toThrow('10 tags');
    expect(current).toEqual(tenTags());
  });
  it.each(['add', 'remove'])('refuses malformed current or incoming tags for %s', action => {
    for (const value of [undefined, null, [' first'], ['first', 'first'], ['a'.repeat(21)]]) {
      expect(() => mergeBulkTags(value, ['second'], action)).toThrow();
      expect(() => mergeBulkTags(['first'], value, action)).toThrow();
    }
  });
  it.each([undefined, null, '', 'replace', 'ADD'])('refuses unknown action %j', action => {
    expect(() => mergeBulkTags(['first'], ['second'], action)).toThrow();
  });
});
