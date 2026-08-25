import { describe, expect, it, vi } from 'vitest';
import {
  auditWorkspace,
  buildRosterRepairMap,
  classifyPostRows,
  listAllDocuments,
  normalizeFirestoreUpdateTime,
  parseCollectionPage,
  parseRosterSnapshot,
  requestJsonObject,
  reviewStageBackfillPlan,
  postUpdatedAtAudit,
} from './adminCore.mjs';

const stringField = (value) => ({ stringValue: value });
const row = (collection, id, values = {}) => ({
  id,
  name: `projects/test/databases/(default)/documents/${collection}/${id}`,
  updateTime: '2026-08-24T12:00:00.000Z',
  fields: Object.fromEntries(Object.entries(values).map(([key, value]) => [
    key,
    value && typeof value === 'object' && !Array.isArray(value) ? value : stringField(value),
  ])),
});
const apiDocument = (collection, id, values = {}) => {
  const { id: _id, ...document } = row(collection, id, values);
  return document;
};

describe('admin response validation', () => {
  const response = (payload, overrides = {}) => ({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(payload),
    ...overrides,
  });

  it('rejects undecodable JSON and every non-object top-level shape', async () => {
    await expect(requestJsonObject({
      fetchImpl: vi.fn().mockResolvedValue(response(null, { json: vi.fn().mockRejectedValue(new Error('bad')) })),
      url: 'https://example.test',
    })).rejects.toThrow(/invalid JSON/);

    for (const payload of [null, [], 'text', 7, true]) {
      await expect(requestJsonObject({
        fetchImpl: vi.fn().mockResolvedValue(response(payload)),
        url: 'https://example.test',
      })).rejects.toThrow(/non-object JSON payload/);
    }
    await expect(requestJsonObject({
      fetchImpl: vi.fn().mockResolvedValue(response(new (class UnexpectedShape {})())),
      url: 'https://example.test',
    })).rejects.toThrow(/non-object JSON payload/);
  });

  it('accepts only canonical empty objects and rejects missing, scalar, or malformed document shapes', () => {
    expect(parseCollectionPage({}, 'posts')).toEqual({ rows: [], nextPageToken: '' });
    expect(() => parseCollectionPage({ nextPageToken: 'partial' }, 'posts'))
      .toThrow(/missing\/malformed documents array/);
    expect(() => parseCollectionPage({ documents: {} }, 'posts')).toThrow(/missing\/malformed documents array/);
    expect(() => parseCollectionPage({ documents: [null] }, 'posts')).toThrow(/malformed document/);
    expect(() => parseCollectionPage({ documents: [{
      name: 'projects/test/databases/(default)/documents/posts/x',
      fields: [],
      updateTime: '2026-08-24T12:00:00Z',
    }] }, 'posts'))
      .toThrow(/malformed document fields/);
    expect(() => parseCollectionPage({ documents: [{
      name: 'projects/test/databases/(default)/documents/posts/x',
      fields: { uid: 'not-a-Firestore-value' },
      updateTime: '2026-08-24T12:00:00Z',
    }] }, 'posts')).toThrow(/malformed typed field/);
    expect(() => parseCollectionPage({ documents: [{
      name: 'projects/test/databases/(default)/documents/other/x',
      fields: {},
      updateTime: '2026-08-24T12:00:00Z',
    }] }, 'posts')).toThrow(/malformed document resource name/);
    expect(() => parseCollectionPage({ documents: [{
      name: 'projects/test/databases/(default)/documents/posts/x',
      fields: {},
    }] }, 'posts')).toThrow(/malformed document updateTime/);
    expect(() => parseCollectionPage({ documents: [], nextPageToken: 9 }, 'posts'))
      .toThrow(/malformed page token/);
    expect(() => parseCollectionPage({ documents: [], unexpected: true }, 'posts'))
      .toThrow(/unknown response field/);
    expect(() => parseCollectionPage({ documents: [{
      ...apiDocument('posts', 'x'),
      unexpected: true,
    }] }, 'posts')).toThrow(/malformed document/);
    expect(() => parseCollectionPage({ documents: [{
      ...apiDocument('posts', 'x'),
      fields: { uid: { stringValue: 'owner', bogus: true } },
    }] }, 'posts')).toThrow(/unknown\/ambiguous typed field/);
    expect(() => parseCollectionPage({ documents: [{
      ...apiDocument('posts', 'x'),
      fields: { tags: { arrayValue: { values: [], bogus: true } } },
    }] }, 'posts')).toThrow(/malformed arrayValue/);
  });

  it('paginates only valid collection responses and rejects repeated tokens', async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({ documents: [apiDocument('posts', 'one')], nextPageToken: 'next' })
      .mockResolvedValueOnce({ documents: [apiDocument('posts', 'two')] });
    await expect(listAllDocuments({ collection: 'posts', fields: ['uid'], fetchPage }))
      .resolves.toMatchObject([{ id: 'one' }, { id: 'two' }]);
    expect(fetchPage.mock.calls[1][0]).toContain('pageToken=next');

    const repeating = vi.fn().mockResolvedValue({ documents: [], nextPageToken: 'same' });
    await expect(listAllDocuments({ collection: 'posts', fields: [], fetchPage: repeating }))
      .rejects.toThrow(/repeated a page token/);
  });
});

describe('canonical roster audit', () => {
  const roster = [
    { slug: 'acme', name: 'Acme' },
    { slug: 'beta', name: 'Beta' },
  ];

  it('parses a strict, non-ambiguous roster snapshot', () => {
    expect(parseRosterSnapshot({ clients: roster })).toEqual(roster);
    expect(() => parseRosterSnapshot({ clients: [{ slug: 'Acme!', name: 'Acme' }] }))
      .toThrow(/invalid canonical slug/);
    expect(() => parseRosterSnapshot({ clients: [...roster, { slug: 'acme', name: 'Other' }] }))
      .toThrow(/repeats canonical slug/);
    expect(() => parseRosterSnapshot({ clients: [...roster, { slug: 'other', name: ' ACME ' }] }))
      .toThrow(/repeats canonical client name/);
  });

  it('refuses two canonical roster names that collide under legacy slug repair', () => {
    const slugify = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    expect(() => buildRosterRepairMap([
      { slug: 'ampersand-client', name: 'A&B' },
      { slug: 'space-client', name: 'A B' },
    ], slugify)).toThrow(/repair-name collision/);
    expect(buildRosterRepairMap(roster, slugify).get('acme')).toBe('acme');
  });

  it('audits ordinary posts and suggestion provenance against the roster and detects split mappings', () => {
    const posts = [
      row('posts', 'ordinary-a', { uid: 'owner', clientId: 'acme', client: 'Acme', reviewStage: 'in_review' }),
      row('posts', 'ordinary-b', { uid: 'owner', clientId: 'beta', client: 'Acme', reviewStage: 'private' }),
      row('posts', 'ordinary-c', { uid: 'owner', clientId: 'acme', client: 'Acme Co', reviewStage: 'private' }),
      row('posts', 'off-roster', { uid: 'owner', clientId: 'phantom', client: 'Phantom', reviewStage: 'private' }),
      row('posts', 'bad-source', {
        uid: 'owner', source: { integerValue: '1' }, clientId: 'acme', client: 'Acme', reviewStage: 'private',
      }),
      row('posts', 'suggestion-ok', {
        uid: 'owner', source: 'suggestion', clientId: '', forClientId: 'acme', client: 'Acme', reviewStage: 'private',
      }),
      row('posts', 'suggestion-bad', {
        uid: 'other', source: 'suggestion', clientId: 'acme', forClientId: 'phantom', client: 'Acme', reviewStage: 'in_review',
      }),
    ];
    const audit = auditWorkspace({
      posts,
      clients: [row('clients', 'acme', { uid: 'owner', clientId: 'acme', name: 'Acme' })],
      automations: [row('automations', 'auto', { ownerUid: 'owner', clientId: 'beta', client: 'Beta' })],
      shares: [
        row('shares', 'share', { ownerUid: 'owner', clientId: 'acme', client: 'Acme' }),
        row('shares', 'missing-name', { ownerUid: 'owner', clientId: 'beta' }),
      ],
      roster,
      ownerUid: 'owner',
    });

    expect(audit.claims.ordinaryPosts.offRoster.map((item) => item.id)).toEqual(['off-roster']);
    expect(audit.claims.suggestions.offRoster.map((item) => item.id)).toEqual(['suggestion-bad']);
    expect(audit.suggestionClientId.invalid.map((item) => item.id)).toEqual(['suggestion-bad']);
    expect(audit.suggestionStage.invalid.map((item) => item.id)).toEqual(['suggestion-bad']);
    expect(audit.postUids.wrong.map((item) => item.id)).toEqual(['suggestion-bad']);
    expect(audit.malformedSources.map((item) => item.id)).toEqual(['bad-source']);
    expect(audit.names.shares.missing.map((item) => item.id)).toEqual(['missing-name']);
    expect(audit.mappings.idToMultipleNames).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'acme' }),
    ]));
    expect(audit.mappings.nameToMultipleIds).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Acme', ids: expect.arrayContaining(['acme', 'beta']) }),
    ]));
    expect(audit.mappings.rosterMismatches.map((item) => item.row.id))
      .toEqual(expect.arrayContaining(['ordinary-b', 'ordinary-c']));
  });
});

describe('suggestion-aware review-stage backfill', () => {
  it('classifies malformed source separately and flags every non-empty/non-string suggestion tenant', () => {
    const ordinary = row('posts', 'ordinary', { clientId: 'acme' });
    const safe = row('posts', 'safe-suggestion', { source: 'suggestion', clientId: '' });
    const tenant = row('posts', 'tenant-suggestion', { source: 'suggestion', clientId: 'acme' });
    const malformedTenant = row('posts', 'malformed-tenant', {
      source: 'suggestion', clientId: { integerValue: '1' },
    });
    const malformedSource = row('posts', 'malformed-source', { source: { integerValue: '1' } });
    const classified = classifyPostRows([ordinary, safe, tenant, malformedTenant, malformedSource]);
    expect(classified.ordinaryPosts).toEqual([ordinary]);
    expect(classified.suggestions).toEqual([safe, tenant, malformedTenant]);
    expect(classified.unsafeSuggestionTenants).toEqual([tenant, malformedTenant]);
    expect(classified.malformedSources).toEqual([malformedSource]);
  });

  it('keeps missing suggestions private and refuses an explicit tenant-readable suggestion', () => {
    const ordinary = row('posts', 'ordinary', { uid: 'owner' });
    const suggestion = row('posts', 'suggestion', { uid: 'owner', source: 'suggestion', clientId: '', forClientId: 'acme' });
    const unsafe = row('posts', 'unsafe', {
      uid: 'owner', source: 'suggestion', clientId: '', forClientId: 'acme', reviewStage: 'in_review',
    });
    const malformed = row('posts', 'malformed', { uid: 'owner', source: { integerValue: '1' } });
    const plan = reviewStageBackfillPlan([ordinary, suggestion, unsafe, malformed]);
    expect(plan.changes).toEqual([
      { row: ordinary, value: 'in_review' },
      { row: suggestion, value: 'private' },
    ]);
    expect(plan.unsafeSuggestions).toEqual([unsafe]);
    expect(plan.malformedSources).toEqual([malformed]);
    expect(plan.updatedAtChanges).toHaveLength(4);
    expect(plan.updatedAtChanges.every(({ value }) => value === '2026-08-24T12:00:00.000Z')).toBe(true);
  });

  it('derives missing updatedAt from updateTime and refuses malformed explicit values', () => {
    expect(normalizeFirestoreUpdateTime('2026-08-24T12:00:00.123456789Z'))
      .toBe('2026-08-24T12:00:00.123Z');
    expect(normalizeFirestoreUpdateTime('2026-02-31T12:00:00Z')).toBe('');

    const missing = row('posts', 'missing', { reviewStage: 'in_review' });
    missing.updateTime = '2026-08-24T12:00:00.987654Z';
    const invalid = row('posts', 'invalid', {
      reviewStage: 'in_review', updatedAt: 'not-an-iso-time',
    });
    const nonString = row('posts', 'non-string', {
      reviewStage: 'in_review', updatedAt: { integerValue: '1' },
    });
    const audit = postUpdatedAtAudit([missing, invalid, nonString]);
    expect(audit.missing).toEqual([missing]);
    expect(audit.invalid).toEqual([invalid]);
    expect(audit.nonString).toEqual([nonString]);

    const plan = reviewStageBackfillPlan([missing, invalid, nonString]);
    expect(plan.updatedAtChanges).toEqual([{ row: missing, value: '2026-08-24T12:00:00.987Z' }]);
    expect(plan.invalidUpdatedAt).toEqual([nonString, invalid]);
  });
});
