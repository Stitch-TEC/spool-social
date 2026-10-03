import { describe, expect, it } from 'vitest';
import { normalizeVideoTitle, VIDEO_TITLE_LIMIT } from './videoLibrary';

describe('optional video title', () => {
  it('keeps old callers and blank titles valid and trims only the edges', () => {
    expect(normalizeVideoTitle()).toBe('');
    expect(normalizeVideoTitle('   ')).toBe('');
    expect(normalizeVideoTitle('  P01 — CT demo v2  ')).toBe('P01 — CT demo v2');
    expect(normalizeVideoTitle('two  spaces')).toBe('two  spaces');
    expect(normalizeVideoTitle('x'.repeat(VIDEO_TITLE_LIMIT))).toHaveLength(VIDEO_TITLE_LIMIT);
  });
  it.each([null, false, 1, [], {}, 'x'.repeat(121), 'one\ntwo', 'one\ttwo', 'one\u0000two', '\u007f', '\u0085', 'right\u202eleft', '\u200b', '\ufeff', 'one\u2028two', 'one\u2029two'])(
    'refuses invalid metadata whole: %j', value => expect(normalizeVideoTitle(value)).toBeNull());
  it('does not interpret plain text as markup', () => {
    expect(normalizeVideoTitle('<b>video</b> & https://example.com')).toBe('<b>video</b> & https://example.com');
  });
});
