import { describe, expect, it } from 'vitest';
import { hasViewName, normalizeViewName, parseSavedViews, resolveViewClient, savedViewsKey, serializeSavedViews, validViewFilters } from './savedViews';

const filters = { clientSlug: 'lyf-fit', review: 'changes', status: null, platform: null, media: null, needs: null, sort: 'scheduled_asc' };
const view = { name: 'Lyf Fit — Changes', filters };
const roster = { clients: [{ slug: 'lyf-fit', name: 'Lyf Fit' }, { slug: 'alpha', name: 'Alpha' }], loading: false, error: null };

describe('saved views strict storage format', () => {
  it('round trips only the explicit preference schema', () => {
    expect(parseSavedViews(serializeSavedViews([view]))).toEqual([view]);
    expect(parseSavedViews(null)).toEqual([]);
  });
  it('uses exact encoded project and UID boundaries', () => {
    expect(savedViewsKey('a:b', 'c')).not.toBe(savedViewsKey('a', 'b:c'));
    expect(savedViewsKey('a', 'ABC')).not.toBe(savedViewsKey('a', 'abc'));
    expect(savedViewsKey('', 'uid')).toBeNull();
    expect(savedViewsKey('project', null)).toBeNull();
  });
  it('normalizes names and rejects case-insensitive duplicates', () => {
    expect(normalizeViewName('  Approved   blogs ')).toBe('Approved blogs');
    expect(hasViewName([view], 'lyf fit — changes')).toBe(true);
    expect(() => serializeSavedViews([view, { ...view, name: 'lyf fit — changes' }])).toThrow();
  });
  it.each([
    '', '{', 'null', '[]', 'false', '1', '{"version":2,"views":[]}',
    '{"version":1,"views":{},"content":"x"}',
    JSON.stringify({ version: 1, views: [view], extra: true }),
    JSON.stringify({ version: 1, views: [{ ...view, content: 'never persist this' }] }),
    JSON.stringify({ version: 1, views: [{ ...view, filters: { ...filters, tag: 'secret' } }] }),
    JSON.stringify({ version: 1, views: [{ ...view, name: '' }] }),
    JSON.stringify({ version: 1, views: [{ ...view, name: ' x ' }] }),
    JSON.stringify({ version: 1, views: [{ ...view, name: 'x'.repeat(49) }] }),
    JSON.stringify({ version: 1, views: [{ ...view, name: 'a\u0000b' }] }),
    JSON.stringify({ version: 1, views: Array.from({ length: 13 }, (_, i) => ({ ...view, name: `View ${i}` })) }),
    ' '.repeat(12001),
  ])('refuses malformed/unversioned/oversized data %# without salvage or rewriting', raw => {
    expect(() => parseSavedViews(raw)).toThrow();
  });
  it.each([
    ['review', 'suggestions'], ['status', 'archived'], ['platform', 'unknown'], ['media', 'all'],
    ['needs', false], ['sort', null], ['clientSlug', 'Lyf Fit'], ['clientSlug', ''], ['clientSlug', '../alpha'],
  ])('refuses unsupported %s=%s', (key, value) => {
    expect(validViewFilters({ ...filters, [key]: value })).toBe(false);
  });
  it('accepts all-client approved blogs and all allowed fields', () => {
    expect(validViewFilters({ clientSlug: null, review: 'approved', status: 'draft', platform: 'blog', media: 'without', needs: 'no_date', sort: 'created_desc' })).toBe(true);
  });
});

describe('strict canonical client lookup for saved views', () => {
  it('resolves normalized display name only to a real roster slug', () => {
    expect(resolveViewClient(roster, { name: ' LYF  FIT ' })).toEqual({ ok: true, slug: 'lyf-fit', name: 'Lyf Fit' });
    expect(resolveViewClient(roster, { name: 'Unknown Client' })).toEqual({ ok: false });
  });
  it('applies the saved slug to its current renamed label', () => {
    expect(resolveViewClient({ ...roster, clients: [{ slug: 'lyf-fit', name: 'Lyf Studio' }] }, { slug: 'lyf-fit' })).toEqual({ ok: true, slug: 'lyf-fit', name: 'Lyf Studio' });
  });
  it.each([
    { ...roster, loading: true }, { ...roster, error: 'unavailable' }, { ...roster, clients: [] },
    { ...roster, clients: [{ slug: 'a', name: 'Lyf Fit' }, { slug: 'b', name: ' LYF  FIT ' }] },
    { ...roster, clients: [{ slug: 'lyf-fit', name: 'Lyf Fit' }, { slug: 'lyf-fit', name: 'Other' }] },
    { ...roster, clients: [{ slug: 'lyf-fit', name: 'Lyf Fit' }, { slug: 'lyf-fit', name: 'Lyf Fit' }] },
  ])('never converts unresolved or ambiguous clients into all clients %#', current => {
    expect(resolveViewClient(current, { slug: 'lyf-fit' })).toEqual({ ok: false });
  });
  it('only an explicit null is all clients, even without a roster', () => {
    expect(resolveViewClient({ loading: true }, { slug: null })).toEqual({ ok: true, slug: null, name: null });
    expect(resolveViewClient(roster, {})).toEqual({ ok: false });
  });
});
