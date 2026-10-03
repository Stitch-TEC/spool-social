import { describe, expect, it } from 'vitest';
import { captureRecoveryWork, clearRecovery, inspectRecovery, olderRecoveryPresence,
  olderRecoveryScope, readRecovery, recoveryMatchesLoaded, recoveryScope,
  restoreRecoveryWork, writeRecovery } from './editorRecovery';

describe('recovery identity envelope', () => {
  it('separates principals, clients, new flows and document IDs without delimiter collisions', () => {
    const scopes = [
      { principalId: 'a', clientId: 'alpha' }, { principalId: 'b', clientId: 'alpha' },
      { principalId: 'a', clientId: 'beta' }, { principalId: 'a', clientId: 'alpha', isTemplate: true },
      { principalId: 'a', clientId: 'alpha', postId: 'new' },
      { principalId: 'a:alpha', clientId: 'alpha', postId: 'doc/1' },
    ].map(recoveryScope);
    expect(new Set(scopes.map(s => s.key)).size).toBe(scopes.length);
  });
  it.each([{ principalId: '', clientId: 'alpha' }, { principalId: 'a', clientId: '' }, { principalId: 'a', clientId: 'Not a slug' }])('refuses unknown/invalid identity %j', input => {
    expect(recoveryScope(input)).toBeNull();
  });
  it('checks embedded ownership rather than trusting a moved storage key', () => {
    const scope = recoveryScope({ principalId: 'b', clientId: 'beta' });
    const foreign = recoveryScope({ principalId: 'a', clientId: 'alpha' });
    expect(readRecovery({ getItem: () => JSON.stringify({ scope: foreign, work: { content: 'Secret' } }) }, scope)).toBeNull();
  });
  it.each([{ content: 'Draft', tags: {} }, { content: 'Draft', isTemplate: 'yes' }, { content: ['invalid'] }, { content: 'Draft', imageUrl: {} }])('rejects malformed work %j', work => {
    const scope = recoveryScope({ principalId: 'a', clientId: 'alpha' });
    expect(readRecovery({ getItem: () => JSON.stringify({ scope, work }) }, scope)).toBeNull();
  });
});

describe('deliberate lossless localStorage v3 recovery', () => {
  const scope = recoveryScope({ principalId: 'owner', clientId: 'omni', postId: 'thread-1' });
  const media = { id: 'review_video_item_001', url: 'https://www.youtube.com/watch?v=abcdefghijk', label: 'P01', version: 'v1' };
  const storage = (initial = {}) => {
    const values = new Map(Object.entries(initial));
    return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key), key: index => [...values.keys()][index] ?? null,
      get length() { return values.size; } };
  };

  it('uses a distinct key and only inventories unscoped keys, without reading their values', () => {
    expect(scope.version).toBe(3);
    expect(scope.key).toMatch(/^spool:autosave:v3:/);
    const v2 = olderRecoveryScope(scope);
    expect(v2.version).toBe(2);
    const store = storage({ [v2.key]: 'older', 'spool:autosave:thread-1': 'unscoped', 'spool:autosave:foreign': 'other' });
    store.getItem = () => { throw new Error('No value reads during inventory'); };
    expect(olderRecoveryPresence(store, scope)).toEqual({ scoped: true, unscoped: true, unavailable: false });
  });

  it.each([
    { content: 'Caption' },
    { content: 'Caption', reviewDetailsVersion: 1 },
    { content: 'Caption', reviewDetailsVersion: 1, firstComment: '', reviewMedia: [] },
    { content: 'Caption', reviewDetailsVersion: 1, firstComment: 'First comment', reviewMedia: [media] },
  ])('round-trips exact optional field presence and value %#', form => {
    const store = storage();
    const captured = captureRecoveryWork(form, 123);
    expect(writeRecovery(store, scope, captured.work, null).state).toBe('stored');
    const entry = readRecovery(store, scope);
    expect(entry.work).toEqual({ ...form, savedAt: 123 });
    const restored = restoreRecoveryWork({ content: 'Old', client: 'Renamed OMNI' }, entry.work);
    expect(restored).toEqual({ ...form, client: 'Renamed OMNI' });
    if (form.reviewMedia?.length) {
      captured.work.reviewMedia[0].label = 'Mutated local array';
      expect(form.reviewMedia[0].label).toBe('P01');
      expect(entry.work.reviewMedia[0].label).toBe('P01');
    }
  });

  it('omits new data-URL images without blanking a previously saved image on restore', () => {
    const captured = captureRecoveryWork({ content: 'Draft', imageUrl: 'data:image/png;base64,YQ==', tags: [] }, 1);
    expect(captured.imageOmitted).toBe(true);
    expect(captured.work).not.toHaveProperty('imageUrl');
    expect(restoreRecoveryWork({ content: 'Old', client: 'OMNI', imageUrl: 'https://example.test/old.png' }, captured.work).imageUrl).toBe('https://example.test/old.png');
  });

  it('does not consider omitted/empty extension fields or marker absence interchangeable', () => {
    expect(recoveryMatchesLoaded({ content: 'Caption' }, { content: 'Caption', reviewDetailsVersion: 1 })).toBe(false);
    expect(recoveryMatchesLoaded({ content: 'Caption', reviewDetailsVersion: 1 }, { content: 'Caption', reviewDetailsVersion: 1, firstComment: '' })).toBe(false);
    expect(recoveryMatchesLoaded({ content: 'Caption', reviewDetailsVersion: 1 }, { content: 'Caption', reviewDetailsVersion: 1 })).toBe(true);
    expect(() => restoreRecoveryWork({ content: 'Saved', reviewDetailsVersion: 1, firstComment: 'Newer' }, { content: 'Older' })).toThrow(/predates/);
  });

  it('explicitly reads only a correctly scoped legacy v2 envelope and never writes/deletes it', () => {
    const older = olderRecoveryScope(scope);
    const raw = JSON.stringify({ scope: older, work: { content: 'Old work', savedAt: 12 } });
    const store = storage({ [older.key]: raw });
    expect(readRecovery(store, scope)).toBeNull();
    expect(inspectRecovery(store, older).entry.work.content).toBe('Old work');
    expect(writeRecovery(store, older, { content: 'New' }, raw).state).toBe('invalid');
    expect(clearRecovery(store, older, raw).state).toBe('invalid');
    expect(store.getItem(older.key)).toBe(raw);
    store.setItem(older.key, JSON.stringify({ scope: older, work: { content: 'Old work', reviewDetailsVersion: 1 } }));
    expect(inspectRecovery(store, older).state).toBe('invalid');
  });

  it.each([
    { content: 'Draft', unknown: 'Do not silently drop' },
    { content: 'Draft', savedAt: 'now' }, { content: 'Draft', savedAt: -1 },
    { content: 'Draft', tags: [3] }, { content: 'Draft', firstComment: 'Missing marker' },
    { content: 'Draft', reviewDetailsVersion: 1, reviewMedia: [{ ...media, unknown: true }] },
    { content: 'Draft', reviewDetailsVersion: 1, firstComment: 'x'.repeat(4001) },
  ])('retains malformed/unknown device work instead of overwriting or deleting it %#', work => {
    const raw = JSON.stringify({ scope, work });
    const store = storage({ [scope.key]: raw });
    expect(inspectRecovery(store, scope).state).toBe('invalid');
    expect(writeRecovery(store, scope, { content: 'Current edit' }, raw).state).toBe('invalid');
    expect(clearRecovery(store, scope, raw).state).toBe('invalid');
    expect(store.getItem(scope.key)).toBe(raw);
  });

  it.each(['envelope', 'scope'])('rejects extra %s keys without partial adoption', part => {
    const entry = { scope, work: { content: 'Draft' } };
    if (part === 'scope') entry.scope = { ...scope, unknown: 'future' };
    else entry.unknown = 'future';
    const store = storage({ [scope.key]: JSON.stringify(entry) });
    expect(readRecovery(store, scope)).toBeNull();
  });

  it('detects an observed copy changed by another tab without adopting or clearing it', () => {
    const old = JSON.stringify({ scope, work: { content: 'Old' } });
    const newer = JSON.stringify({ scope, work: { content: 'Other tab' } });
    const store = storage({ [scope.key]: newer });
    expect(writeRecovery(store, scope, { content: 'This tab' }, old).state).toBe('changed');
    expect(clearRecovery(store, scope, old).state).toBe('changed');
    expect(store.getItem(scope.key)).toBe(newer);
  });

  it('does not treat unavailable storage as an empty device copy', () => {
    const store = { getItem: () => { throw new Error('Storage unavailable'); } };
    expect(inspectRecovery(store, scope).state).toBe('unavailable');
    expect(writeRecovery(store, scope, { content: 'Draft' }, null).state).toBe('unavailable');
  });

  it('never overwrites or retires extension-bearing work with an authoring-disabled legacy save', () => {
    const raw = JSON.stringify({ scope, work: { content: 'Extension copy', reviewDetailsVersion: 1, firstComment: 'Keep' } });
    const store = storage({ [scope.key]: raw });
    expect(writeRecovery(store, scope, { content: 'Legacy edit' }, raw).state).toBe('incompatible');
    expect(clearRecovery(store, scope, raw).state).toBe('incompatible');
    expect(store.getItem(scope.key)).toBe(raw);
  });

  it('identifies malformed JSON as retained invalid work rather than empty storage', () => {
    const store = storage({ [scope.key]: '{not valid JSON' });
    expect(inspectRecovery(store, scope).state).toBe('invalid');
    expect(writeRecovery(store, scope, { content: 'Current' }, null).state).toBe('invalid');
    expect(store.getItem(scope.key)).toBe('{not valid JSON');
  });
});
