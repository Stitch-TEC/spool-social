import { describe, it, expect } from 'vitest';
import { sortPosts, SORT_ORDERS, imageKey } from './helpers';

describe('imageKey', () => {
  it('canonicalizes /media URLs to their R2 key across origins and encodings', () => {
    expect(imageKey('https://a.example/media/generated/u/abc.jpg')).toBe('generated/u/abc.jpg');
    expect(imageKey('/media/generated/u/abc.jpg?x=1')).toBe('generated/u/abc.jpg');
    expect(imageKey('https://b.example/media/library/o/my%20client/1.jpg')).toBe('library/o/my client/1.jpg');
  });

  it('passes data URLs and external URLs through unchanged', () => {
    expect(imageKey('data:image/png;base64,AAA')).toBe('data:image/png;base64,AAA');
    expect(imageKey('https://cdn.example/photo.jpg')).toBe('https://cdn.example/photo.jpg');
    expect(imageKey(undefined)).toBe(undefined);
  });
});

const p = (id, ts, created, client, platform) => ({
  id, _sortTs: ts, createdAt: new Date(created), client, platform,
});

// c has the middle schedule ts but Acme+blog; a is latest+Beta+gmb; b is earliest+Acme+linkedin
const posts = [
  p('a', 300, '2025-01-03T00:00:00Z', 'Beta', 'gmb'),
  p('b', 100, '2025-01-01T00:00:00Z', 'Acme', 'linkedin'),
  p('c', 200, '2025-01-02T00:00:00Z', 'Acme', 'blog'),
];
const ids = (arr) => arr.map((x) => x.id);

describe('sortPosts', () => {
  it('defaults to scheduled latest-first (and treats unknown keys the same)', () => {
    expect(ids(sortPosts(posts, SORT_ORDERS.SCHEDULED_DESC))).toEqual(['a', 'c', 'b']);
    expect(ids(sortPosts(posts, 'nonsense'))).toEqual(['a', 'c', 'b']);
    expect(ids(sortPosts(posts, undefined))).toEqual(['a', 'c', 'b']);
  });

  it('sorts scheduled soonest-first', () => {
    expect(ids(sortPosts(posts, SORT_ORDERS.SCHEDULED_ASC))).toEqual(['b', 'c', 'a']);
  });

  it('sorts by created date both directions', () => {
    expect(ids(sortPosts(posts, SORT_ORDERS.CREATED_DESC))).toEqual(['a', 'c', 'b']);
    expect(ids(sortPosts(posts, SORT_ORDERS.CREATED_ASC))).toEqual(['b', 'c', 'a']);
  });

  it('sorts by client A–Z, tiebreaking on most-recent schedule', () => {
    // Acme (c before b: 200>100), then Beta (a)
    expect(ids(sortPosts(posts, SORT_ORDERS.CLIENT_AZ))).toEqual(['c', 'b', 'a']);
  });

  it('sorts by platform name, tiebreaking on schedule', () => {
    // blog(c) < gmb(a) < linkedin(b)
    expect(ids(sortPosts(posts, SORT_ORDERS.PLATFORM))).toEqual(['c', 'a', 'b']);
  });

  it('is pure — never mutates the input array', () => {
    const before = ids(posts);
    sortPosts(posts, SORT_ORDERS.PLATFORM);
    expect(ids(posts)).toEqual(before);
  });

  it('tolerates a null/empty list', () => {
    expect(sortPosts(null, SORT_ORDERS.PLATFORM)).toEqual([]);
    expect(sortPosts([], SORT_ORDERS.SCHEDULED_ASC)).toEqual([]);
  });
});
