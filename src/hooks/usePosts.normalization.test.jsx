import { act, cleanup, renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const firestore = vi.hoisted(() => ({ subscriptions: [] }));
vi.mock('firebase/firestore', () => ({
  collection: vi.fn((_db, name) => ({ name })),
  query: vi.fn((base, ...constraints) => ({ base, constraints })),
  where: vi.fn((...args) => args),
  onSnapshot: vi.fn((query, next, error) => {
    const unsubscribe = vi.fn();
    firestore.subscriptions.push({ query, next, error, unsubscribe });
    return unsubscribe;
  }),
}));
vi.mock('../config/firebase', () => ({ db: {} }));
vi.mock('../utils/helpers', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, versionSpoolMediaContent: vi.fn(actual.versionSpoolMediaContent) };
});
vi.mock('../utils/mediaMarkup', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, transformMediaDestinations: vi.fn(actual.transformMediaDestinations) };
});
vi.mock('micromark', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, parse: vi.fn(actual.parse) };
});
vi.mock('parse5', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, parseFragment: vi.fn(actual.parseFragment) };
});

import usePosts from './usePosts';
import { versionSpoolMediaContent } from '../utils/helpers';
import { transformMediaDestinations } from '../utils/mediaMarkup';
import { parse } from 'micromark';
import { parseFragment } from 'parse5';
const { versionSpoolMediaContent: normalize } = await vi.importActual('../utils/helpers');

const user = { uid: 'reader' };
const raw = 'Exact copy\n![Photo](/media/owner/alpha/image.png)';
const baseData = () => ({
  uid: 'owner', clientId: 'alpha', client: 'Alpha', content: raw, title: 'Original title',
  createdAt: '2026-09-23T12:00:00Z', scheduledDate: '2026-10-01T12:00:00Z',
  reviewStage: 'in_review', approvalStatus: 'pending', tags: ['original'],
});
const baseProps = () => ({ user, clientId: 'alpha', sharedUid: null, shareClientId: null, isOperator: false });
const change = (data = {}, type = 'modified', id = 'post') => ({ type, doc: { id, data: () => ({ ...baseData(), ...data }) } });
const posts = () => firestore.subscriptions.filter(listener => listener.query.base.name === 'posts');
const latest = () => posts().at(-1);
const emit = (changes, listener = latest()) => act(() => listener.next({ docChanges: () => changes }));
const fail = (code, listener = latest()) => act(() => listener.error({ code }));
const mount = (props = baseProps(), options = {}) => renderHook(p => usePosts(
  p.user, p.sharedUid, p.clientId, p.shareClientId, p.isOperator, p.session,
), { initialProps: props, ...options });
const add = data => emit([change(data, 'added')]);
const currentPost = hook => hook.result.current.posts[0];

describe('usePosts attempt-owned content normalization reuse', () => {
  beforeEach(() => {
    firestore.subscriptions.length = 0;
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('skips repeated parsing on metadata updates while refreshing title search and all current fields', () => {
    const hook = mount();
    add();
    const initial = currentPost(hook), keys = Object.keys(initial);
    versionSpoolMediaContent.mockClear();
    emit([change({ title: 'Replacement headline', approvalStatus: 'changes_requested',
      tags: ['new'], scheduledDate: '2026-11-01T12:00:00Z', client: 'Renamed Alpha', feedback: 'Exact feedback' })]);
    const updated = currentPost(hook);
    expect(versionSpoolMediaContent).not.toHaveBeenCalled();
    expect(updated.content).toBe(initial.content);
    expect(updated).not.toBe(initial);
    expect(updated).toMatchObject({ title: 'Replacement headline', approvalStatus: 'changes_requested',
      tags: ['new'], client: 'Renamed Alpha', feedback: 'Exact feedback', _searchClient: 'renamed alpha' });
    expect(updated._searchContent).toBe(`Replacement headline\n${normalize(raw)}`.toLowerCase());
    expect(updated._searchContent).not.toContain('original title');
    expect(updated._sortTs).toBe(new Date('2026-11-01T12:00:00Z').getTime());
    expect(updated.createdAt).toBe(initial.createdAt);
    expect(Object.keys(updated).sort()).toEqual([...keys, 'feedback'].sort());
    expect(Object.getOwnPropertySymbols(updated)).toEqual([]);
    expect(JSON.stringify({ ...updated })).not.toContain('rawContent');
  });

  it('uses the private derived string rather than a consumer-mutated post content field', () => {
    const hook = mount(); add();
    currentPost(hook).content = 'Consumer-mutated copy';
    versionSpoolMediaContent.mockClear();
    emit([change({ title: 'Still current' })]);
    expect(versionSpoolMediaContent).not.toHaveBeenCalled();
    expect(currentPost(hook).content).toBe(normalize(raw));
  });

  it.each([
    ['whitespace', raw + ' '],
    ['different image', raw.replace('image.png', 'other.png')],
    ['already v2', raw.replace('/media/', '/media/v2/')],
    ['external media', raw.replace('/media/', 'https://external.invalid/media/')],
    ['HTML and entities', '<img src="&#47media/owner/alpha/image.png" srcset="/media/owner/alpha/a.png 1x, /media/owner/alpha/b.png 2x">'],
    ['escaped Markdown', '![Caption](/media/owner/alpha/a\\(b\\).png)'],
    ['plain media prose', 'Example /media/path is prose, not an image.'],
  ])('invalidates exact raw input on %s and matches the unchanged parser output', (_label, content) => {
    const hook = mount(); add();
    versionSpoolMediaContent.mockClear();
    emit([change({ content })]);
    expect(versionSpoolMediaContent).toHaveBeenCalled();
    expect(currentPost(hook).content).toBe(normalize(content));
    versionSpoolMediaContent.mockClear();
    emit([change({ content, title: 'Metadata only' })]);
    expect(versionSpoolMediaContent).not.toHaveBeenCalled();
    expect(currentPost(hook)._searchContent).toBe(`Metadata only\n${normalize(content)}`.toLowerCase());
  });

  it.each([undefined, null, false, 0, 42, ['legacy', raw], { text: raw }])('does not cache non-string legacy content %j', content => {
    const hook = mount(); add({ content });
    versionSpoolMediaContent.mockClear();
    emit([change({ content, title: 'New title' })]);
    expect(versionSpoolMediaContent).toHaveBeenCalled();
    expect(currentPost(hook).content).toBe(normalize(content || ''));
  });

  it('preserves coercion for a mutable legacy value rather than reusing its object identity', () => {
    const content = { text: raw, toString() { return this.text; } };
    const hook = mount(); add({ content });
    content.text = 'Changed legacy object';
    emit([change({ content })]);
    expect(currentPost(hook).content).toBe('Changed legacy object');
  });

  it.each([
    ['owner', { uid: 'other-owner' }], ['client', { clientId: 'beta' }],
    ['missing owner', { uid: undefined }], ['empty owner', { uid: '' }],
    ['malformed owner', { uid: { value: 'owner' } }], ['whitespace owner', { uid: ' owner ' }],
    ['missing client', { clientId: undefined }], ['malformed client', { clientId: 'Alpha Name' }],
    ['suggestion', { source: 'suggestion' }], ['implied tenant', { forClientId: 'beta' }],
  ])('does not reuse across %s ownership', (_label, data) => {
    const hook = mount(); add();
    versionSpoolMediaContent.mockClear();
    emit([change(data)]);
    expect(versionSpoolMediaContent).toHaveBeenCalled();
    expect(currentPost(hook).content).toBe(normalize(raw));
  });

  it('keeps the real document ID in private metadata when a malformed stored id overrides the public id', () => {
    const hook = mount();
    emit([change({ id: 'different-document' }, 'added', 'first-document')]);
    versionSpoolMediaContent.mockClear();
    emit([change({}, 'modified', 'different-document')]);
    expect(versionSpoolMediaContent).toHaveBeenCalled();
    expect(currentPost(hook).content).toBe(normalize(raw));
  });

  it.each([true, false])('normalizes removed/re-added content again (same snapshot: %s)', sameSnapshot => {
    const hook = mount(); add();
    versionSpoolMediaContent.mockClear();
    if (sameSnapshot) emit([change({}, 'removed'), change({}, 'added')]);
    else { emit([change({}, 'removed')]); add(); }
    expect(versionSpoolMediaContent).toHaveBeenCalled();
    expect(currentPost(hook).content).toBe(normalize(raw));
  });

  it('new retry attempts parse again, replace membership and reject inherited callbacks', () => {
    vi.useFakeTimers();
    const hook = mount(); add();
    const old = latest();
    fail('unavailable');
    act(() => vi.advanceTimersByTime(1000));
    versionSpoolMediaContent.mockClear();
    add();
    expect(versionSpoolMediaContent).toHaveBeenCalled();
    const current = currentPost(hook);
    versionSpoolMediaContent.mockClear();
    emit([change({ content: 'Obsolete callback' })], old);
    expect(versionSpoolMediaContent).not.toHaveBeenCalled();
    expect(currentPost(hook)).toBe(current);
    fail('unavailable');
    act(() => vi.advanceTimersByTime(1000));
    emit([]);
    expect(hook.result.current.posts).toEqual([]);
  });

  it('does not repopulate cache metadata from an updater queued before terminal listener failure', () => {
    const NativeWeakMap = globalThis.WeakMap;
    const cacheWrites = [];
    vi.stubGlobal('WeakMap', class extends NativeWeakMap {
      set(key, value) {
        if (value?.rawContent === raw && value?.uid === 'owner') cacheWrites.push(value);
        return super.set(key, value);
      }
    });
    const hook = mount(); add();
    expect(cacheWrites.length).toBeGreaterThan(0);
    cacheWrites.length = 0;
    const branding = firestore.subscriptions.find(listener => listener.query.base.name === 'clients');
    const postListener = latest();
    act(() => {
      // Queue behind a state update so this snapshot's updater is not eager.
      branding.next({ docChanges: () => [] });
      postListener.next({ docChanges: () => [change({ title: 'Queued title' })] });
      postListener.error({ code: 'failed-precondition' });
    });
    expect(currentPost(hook).title).toBe('Queued title');
    expect(hook.result.current).toMatchObject({ error: { code: 'failed-precondition' }, isStalled: true });
    expect(cacheWrites).toEqual([]);
  });

  it.each([
    ['client', props => ({ ...props, clientId: 'beta' })],
    ['UID', props => ({ ...props, user: { uid: 'new-reader' } })],
    ['same UID user object', props => ({ ...props, user: { uid: user.uid } })],
    ['auth revision', props => ({ ...props, session: { authRevision: 2 } })],
    ['role', props => ({ ...props, clientId: null, isOperator: true })],
  ])('never shares derived entries with a new %s scope', (_label, next) => {
    const props = baseProps();
    const hook = mount(props); add();
    const old = latest();
    hook.rerender(next(props));
    expect(hook.result.current.posts).toEqual([]);
    versionSpoolMediaContent.mockClear(); add();
    expect(versionSpoolMediaContent).toHaveBeenCalled();
    versionSpoolMediaContent.mockClear();
    emit([change({ title: 'Late' })], old);
    expect(versionSpoolMediaContent).not.toHaveBeenCalled();
    expect(currentPost(hook).title).toBe('Original title');
  });

  it('clears after denial or sign-out, rejects stale callbacks and reparses on a new session', () => {
    const props = baseProps();
    const hook = mount(props); add();
    const old = latest();
    fail('permission-denied');
    expect(hook.result.current.posts).toEqual([]);
    versionSpoolMediaContent.mockClear();
    emit([change()], old);
    expect(versionSpoolMediaContent).not.toHaveBeenCalled();
    hook.rerender({ ...props, user: null });
    hook.rerender({ ...props, user: { uid: user.uid } });
    add();
    expect(versionSpoolMediaContent).toHaveBeenCalled();
    expect(currentPost(hook).content).toBe(normalize(raw));
  });

  it('keeps StrictMode replay output equivalent and ignores callbacks after unmount', () => {
    const hook = mount(baseProps(), { wrapper: StrictMode }); add();
    emit([change({ title: 'Updated' })]);
    expect(currentPost(hook).content).toBe(normalize(raw));
    expect(currentPost(hook)._searchContent).toBe(`Updated\n${normalize(raw)}`.toLowerCase());
    const old = latest(); hook.unmount();
    versionSpoolMediaContent.mockClear();
    emit([change()], old);
    expect(versionSpoolMediaContent).not.toHaveBeenCalled();
  });

  it.each(['outer', 'markdown', 'html'])('does not cache a transient %s parser fallback and retries the next metadata update', kind => {
    const content = `${raw}\n\n<img src="/media/owner/alpha/html.png">`;
    if (kind === 'outer') transformMediaDestinations.mockImplementationOnce(() => { throw new Error('Synthetic outer failure'); });
    else if (kind === 'markdown') parse.mockImplementationOnce(() => { throw new Error('Synthetic Markdown failure'); });
    else parseFragment.mockImplementationOnce(() => { throw new Error('Synthetic HTML failure'); });
    const hook = mount(); add({ content });
    const fallback = currentPost(hook).content;
    if (kind === 'html') {
      expect(fallback).toContain('https://spool.stitchtec.dev/media/v2/owner/alpha/image.png');
      expect(fallback).toContain('src="/media/owner/alpha/html.png"');
    } else expect(fallback).toBe(content);
    versionSpoolMediaContent.mockClear();
    emit([change({ content, title: 'Retry parser' })]);
    expect(versionSpoolMediaContent).toHaveBeenCalled();
    expect(currentPost(hook).content).toBe(normalize(content));
    versionSpoolMediaContent.mockClear();
    emit([change({ content, title: 'Reuse success' })]);
    expect(versionSpoolMediaContent).not.toHaveBeenCalled();
  });

  it.each(['outer', 'markdown', 'html'])('keeps %s fallback return compatible even if the optional observer throws', kind => {
    const content = '<img src="/media/owner/alpha/html.png">';
    if (kind === 'outer') transformMediaDestinations.mockImplementationOnce(() => { throw new Error('Synthetic outer failure'); });
    else if (kind === 'markdown') parse.mockImplementationOnce(() => { throw new Error('Synthetic Markdown failure'); });
    else parseFragment.mockImplementationOnce(() => { throw new Error('Synthetic HTML failure'); });
    const observer = vi.fn(() => { throw new Error('Synthetic observer failure'); });
    expect(normalize(content, observer)).toBe(content);
    expect(observer).toHaveBeenCalledExactlyOnceWith();
  });
});
