import { describe, expect, it, vi } from 'vitest';
import { versionDraftMedia } from './draftUpdate.js';
import {
  buildPostMutationWrite,
  buildDraftListStructuredQuery,
  collectBoundedDraftRows,
  collectPostImageReferences,
  decodeDraftCursor,
  DRAFT_PAGE_MAX_BYTES,
  DRAFT_RESPONSE_OVERHEAD_BYTES,
  deleteAutomation,
  deletePost,
  deleteShareDoc,
  encodedAutoId,
  encodeDraftCursor,
  filteredDraftTotal,
  getAutomation,
  getPost,
  getShareDoc,
  requireAutoId,
  requireDocumentSegment,
  requireShareToken,
  readRunQueryDocuments,
  readRunAggregationCount,
  runUpdateTimeTransaction,
  updateAutomation,
  updatePost,
} from './firestore.js';

describe('fail-closed Firestore runQuery parsing', () => {
  const response = (body, status = 200) => new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

  it('accepts document results and the canonical readTime-only empty result', async () => {
    await expect(readRunQueryDocuments(response(JSON.stringify([
      { document: {
        name: 'projects/test/databases/(default)/documents/posts/Ab3dEf5hIj7kLm9nOpQr',
        fields: { content: { stringValue: 'ok' }, optional: { nullValue: 'NULL_VALUE' } },
        updateTime: '2026-08-25T01:00:00Z',
      } },
      { readTime: '2026-08-25T01:00:01Z' },
    ])))).resolves.toHaveLength(1);
    await expect(readRunQueryDocuments(response(JSON.stringify([
      { readTime: '2026-08-25T01:00:01Z' },
    ])))).resolves.toEqual([]);
    await expect(readRunQueryDocuments(response('[{"done":true}]'))).resolves.toEqual([]);
    await expect(readRunQueryDocuments(response(JSON.stringify([
      { transaction: 'dHJhbnNhY3Rpb24=' },
      { done: true },
    ])))).resolves.toEqual([]);
  });

  it('rejects invalid JSON, non-arrays, and malformed result messages', async () => {
    await expect(readRunQueryDocuments(response('{'))).rejects.toThrow(/invalid JSON/);
    await expect(readRunQueryDocuments(response('{}'))).rejects.toThrow(/non-array/);
    await expect(readRunQueryDocuments(response('[]'))).rejects.toThrow(/incomplete empty result/);
    await expect(readRunQueryDocuments(response('[null]'))).rejects.toThrow(/malformed result message/);
    await expect(readRunQueryDocuments(response(JSON.stringify([{ document: {
      name: 'projects/test/databases/(default)/documents/posts/x',
      fields: { content: 'not-a-typed-value' },
    } }])))).rejects.toThrow(/malformed Firestore value/);
    await expect(readRunQueryDocuments(response(JSON.stringify([{ document: {
      name: 'projects/test/databases/(default)/documents/posts/x',
      fields: { content: { stringValue: 'ok', bogus: true } },
    } }])))).rejects.toThrow(/unknown\/ambiguous Firestore value/);
    await expect(readRunQueryDocuments(response(JSON.stringify([{ document: {
      name: 'projects/test/databases/(default)/documents/posts/x',
      fields: {},
    }, readTime: 42 }])))).rejects.toThrow(/malformed readTime/);
    await expect(readRunQueryDocuments(response(JSON.stringify([{ document: {
      name: 'posts/x',
      fields: {},
    } }])))).rejects.toThrow(/malformed document result/);
    await expect(readRunQueryDocuments(response(JSON.stringify([{ document: {
      name: 'projects/test/databases/(default)/documents/posts/x',
      fields: {},
      updateTime: '',
    } }])))).rejects.toThrow(/malformed document updateTime/);
    await expect(readRunQueryDocuments(response(JSON.stringify([
      { readTime: '2026-08-25T01:00:01Z', unexpected: true },
    ])))).rejects.toThrow(/malformed result message/);
    await expect(readRunQueryDocuments(response('[{"done":"true"}]'))).rejects.toThrow(/malformed done selector/);
    await expect(readRunQueryDocuments(response('[{"done":false}]'))).rejects.toThrow(/incomplete empty result/);
    await expect(readRunQueryDocuments(response(JSON.stringify([{
      readTime: '2026-08-25T01:00:01Z', done: false,
    }])))).rejects.toThrow(/incomplete empty result/);
    await expect(readRunQueryDocuments(response('[{"transaction":"dHJhbnNhY3Rpb24="}]')))
      .rejects.toThrow(/incomplete empty result/);
    await expect(readRunQueryDocuments(response(JSON.stringify([{
      transaction: 'dHJhbnNhY3Rpb24=', readTime: '2026-08-25T01:00:01Z',
    }])))).rejects.toThrow(/malformed transaction result/);
    await expect(readRunQueryDocuments(response('[{}]'))).rejects.toThrow(/malformed non-document/);
  });

  it('requires projected GC reference fields to be strings', () => {
    expect(() => collectPostImageReferences([{
      fields: { imageUrl: { mapValue: { fields: {} } } },
    }])).toThrow(/non-string imageUrl/);
    expect(collectPostImageReferences([{
      fields: {
        imageUrl: { stringValue: '/media/v2/generated/o/cover.png' },
        content: { stringValue: '![inline](/media/v2/generated/o/inline.png)' },
      },
    }])).toEqual(new Set([
      '/media/v2/generated/o/cover.png',
      '/media/v2/generated/o/inline.png',
    ]));
  });
});

describe('bounded draft pagination', () => {
  const idFor = (value) => value.toString(36).padStart(20, '0');
  const nameFor = (value) => `projects/test/databases/(default)/documents/posts/${idFor(value)}`;
  const updatedAtFor = (value) => new Date(Date.parse('2026-08-25T02:00:00.000Z') - value).toISOString();
  const rowFor = (value, fields = {}) => ({
    id: idFor(value),
    updatedAt: updatedAtFor(value),
    ...fields,
    _cursorName: nameFor(value),
    _cursorUpdatedAt: fields.updatedAt || updatedAtFor(value),
  });

  it('keeps retained allocation bounded while scanning a large filtered collection', async () => {
    const source = Array.from({ length: 1400 }, (_, index) => rowFor(index + 1,
      index < 700 ? { isTemplate: true, content: `template-${index}` } : { content: `draft-${index}` }));
    const readSizes = [];
    const readPage = async (cursor, batchSize) => {
      readSizes.push(batchSize);
      const start = cursor ? source.findIndex(row => row._cursorName === cursor.name) + 1 : 0;
      return source.slice(start, start + batchSize);
    };

    const first = await collectBoundedDraftRows({ readPage, limit: 100, batchSize: 50 });
    expect(first.drafts).toHaveLength(100);
    expect(first.truncated).toBe(true);
    expect(first.nextName).toBe(nameFor(800));
    expect(readSizes.every(size => size === 50)).toBe(true);

    const second = await collectBoundedDraftRows({
      readPage,
      initialCursor: { name: first.nextName, updatedAt: first.nextUpdatedAt },
      limit: 100,
      batchSize: 50,
    });
    expect(second.drafts).toHaveLength(100);
    expect(second.drafts[0].id).toBe(idFor(801));
    expect(new Set([...first.drafts, ...second.drafts].map(row => row.id)).size).toBe(200);
  });

  it('uses the byte ceiling as an honest continuation boundary', async () => {
    const rows = [rowFor(1, { content: 'x'.repeat(100) }), rowFor(2, { content: 'y'.repeat(100) })];
    const page = await collectBoundedDraftRows({
      readPage: async () => rows,
      limit: 10,
      maxBytes: 300,
      batchSize: 2,
    });
    expect(page.drafts).toHaveLength(1);
    expect(page.truncated).toBe(true);
    expect(page.nextName).toBe(nameFor(1));
  });

  it('does not make an oversized first-row exception and measures transformed bytes', async () => {
    const oversized = rowFor(1, { content: 'x'.repeat(500) });
    await expect(collectBoundedDraftRows({
      readPage: async () => [oversized],
      limit: 10,
      maxBytes: 180,
      batchSize: 1,
    })).rejects.toMatchObject({ code: 'draft_row_too_large', status: 413 });

    const rows = [
      rowFor(1, { content: 'short' }),
      rowFor(2, { content: 'also short' }),
    ];
    const transformed = await collectBoundedDraftRows({
      readPage: async (cursor) => cursor ? [] : rows,
      limit: 10,
      maxBytes: 220,
      batchSize: 2,
      transformRow: async (row) => ({ ...row, content: row.content.repeat(12) }),
    });
    expect(transformed.drafts).toHaveLength(1);
    expect(transformed.truncated).toBe(true);
  });

  it('keeps a real encoded response under 1 MiB including revisions and cursor', async () => {
    const rows = Array.from({ length: 1000 }, (_, index) => rowFor(index + 1, {
      clientId: 'acme',
      platform: 'blog',
      title: `Draft ${index}`,
      content: `![cover](/media/generated/o/${index}.png)\n${'x'.repeat(1800)}`,
    }));
    const readPage = async (cursor, batchSize) => {
      const start = cursor ? rows.findIndex(row => row._cursorName === cursor.name) + 1 : 0;
      return rows.slice(start, start + batchSize);
    };
    const page = await collectBoundedDraftRows({
      readPage,
      limit: 1000,
      batchSize: 10,
      maxBytes: DRAFT_PAGE_MAX_BYTES - DRAFT_RESPONSE_OVERHEAD_BYTES,
      transformRow: (row) => versionDraftMedia('https://spool.stitchtec.dev', row),
    });
    const cursor = encodeDraftCursor(
      page.nextName.split('/').pop(),
      page.nextUpdatedAt,
      page.drafts.length,
      JSON.stringify({ clientId: 'acme', reviewStage: 'in_review' }),
      '2026-08-25T01:00:00.123456Z',
    );
    const body = {
      drafts: page.drafts,
      count: page.drafts.length,
      total: rows.length,
      truncated: page.truncated,
      nextCursor: cursor,
    };
    expect(new TextEncoder().encode(JSON.stringify(body)).byteLength).toBeLessThanOrEqual(DRAFT_PAGE_MAX_BYTES);
    expect(page.truncated).toBe(true);
  });

  it('rejects malformed pages, classifications, and non-advancing cursors', async () => {
    await expect(collectBoundedDraftRows({
      readPage: async () => null, limit: 1,
    })).rejects.toThrow(/malformed page/);
    await expect(collectBoundedDraftRows({
      readPage: async () => [rowFor(1, { source: { stringValue: 'suggestion' } })], limit: 1,
    })).rejects.toThrow(/malformed source/);
    await expect(collectBoundedDraftRows({
      readPage: async (cursor) => [rowFor(cursor ? 1 : 1)], limit: 2, batchSize: 1,
    })).rejects.toThrow(/did not advance/);
  });

  it('encodes cursors with their exact filter context and validates count arithmetic', () => {
    const filter = JSON.stringify({ clientId: 'acme', reviewStage: 'in_review' });
    const readTime = '2026-08-25T01:00:00.123456Z';
    const updatedAt = '2026-08-25T00:59:00.000Z';
    const cursor = encodeDraftCursor(idFor(42), updatedAt, 42, filter, readTime);
    expect(decodeDraftCursor(cursor, filter)).toEqual({ id: idFor(42), updatedAt, seen: 42, readTime });
    expect(() => decodeDraftCursor(cursor, JSON.stringify({ clientId: 'beta' }))).toThrow(/draft cursor/);
    expect(() => decodeDraftCursor('%', filter)).toThrow(/draft cursor/);
    expect(filteredDraftTotal({ all: 12, templates: 3, suggestions: 2, templateSuggestions: 1 })).toBe(8);
    expect(() => filteredDraftTotal({ all: 1, templates: 2, suggestions: 0, templateSuggestions: 0 }))
      .toThrow(/inconsistent/);
  });

  it('orders newest-first by updatedAt then document name and builds a full cursor', () => {
    const startAfter = { name: nameFor(42), updatedAt: '2026-08-25T00:59:00.000Z' };
    const query = buildDraftListStructuredQuery('owner', startAfter, 10);
    expect(query.where).toEqual(expect.objectContaining({
      fieldFilter: expect.objectContaining({ field: { fieldPath: 'uid' } }),
    }));
    expect(query.orderBy).toEqual([
      { field: { fieldPath: 'updatedAt' }, direction: 'DESCENDING' },
      { field: { fieldPath: '__name__' }, direction: 'DESCENDING' },
    ]);
    expect(query.startAt).toEqual({
      values: [
        { stringValue: startAfter.updatedAt },
        { referenceValue: startAfter.name },
      ],
      before: false,
    });
    expect(query.select.fields).toContainEqual({ fieldPath: 'updatedAt' });
    expect(query.select.fields).toContainEqual({ fieldPath: 'slug' });
  });

  it('has no duplicates or gaps across ties in the newest-first tuple', async () => {
    const tiedAt = '2026-08-25T01:00:00.000Z';
    const namesDescending = [9, 8, 7, 6, 5, 4, 3, 2, 1];
    const source = namesDescending.map(value => rowFor(value, { updatedAt: tiedAt }));
    const readPage = async (cursor, batchSize) => {
      const start = cursor ? source.findIndex(row => row._cursorName === cursor.name) + 1 : 0;
      return source.slice(start, start + batchSize);
    };
    const first = await collectBoundedDraftRows({ readPage, limit: 4, batchSize: 3 });
    const second = await collectBoundedDraftRows({
      readPage,
      initialCursor: { name: first.nextName, updatedAt: first.nextUpdatedAt },
      limit: 4,
      batchSize: 3,
    });
    const third = await collectBoundedDraftRows({
      readPage,
      initialCursor: { name: second.nextName, updatedAt: second.nextUpdatedAt },
      limit: 4,
      batchSize: 3,
    });
    expect([...first.drafts, ...second.drafts, ...third.drafts].map(row => row.id))
      .toEqual(namesDescending.map(idFor));
  });
});

describe('fail-closed Firestore aggregation parsing', () => {
  const response = (payload, status = 200) => new Response(payload, {
    status, headers: { 'Content-Type': 'application/json' },
  });

  it('accepts one canonical integer count', async () => {
    await expect(readRunAggregationCount(response(JSON.stringify([{
      result: { aggregateFields: { count: { integerValue: '1234' } } },
      readTime: '2026-08-25T01:00:00Z',
      done: true,
    }])))).resolves.toBe(1234);
  });

  it('rejects empty, malformed, duplicated, and non-integer results', async () => {
    await expect(readRunAggregationCount(response('[]'))).rejects.toThrow(/incomplete/);
    await expect(readRunAggregationCount(response('{}'))).rejects.toThrow(/incomplete/);
    await expect(readRunAggregationCount(response('[{"readTime":"2026-08-25T01:00:00Z"}]')))
      .rejects.toThrow(/no count/);
    await expect(readRunAggregationCount(response('[{"done":true}]')))
      .rejects.toThrow(/no count/);
    await expect(readRunAggregationCount(response(JSON.stringify([{
      result: { aggregateFields: { count: { integerValue: '1' } } }, done: false,
    }])))).rejects.toThrow(/incomplete count/);
    await expect(readRunAggregationCount(response(JSON.stringify([
      {
        result: { aggregateFields: { count: { integerValue: '1' } } },
        readTime: '2026-08-25T01:00:00Z',
      },
      { done: true },
    ])))).resolves.toBe(1);
    await expect(readRunAggregationCount(response(JSON.stringify([{
      result: { aggregateFields: { count: { stringValue: '1' } } },
    }])))).rejects.toThrow(/non-integer/);
    await expect(readRunAggregationCount(response(JSON.stringify([
      { result: { aggregateFields: { count: { integerValue: '1' } } } },
      { result: { aggregateFields: { count: { integerValue: '2' } } } },
    ])))).rejects.toThrow(/malformed aggregate/);
    await expect(readRunAggregationCount(response(JSON.stringify([{
      result: { aggregateFields: { count: { integerValue: '1' }, extra: { integerValue: '0' } } },
    }])))).rejects.toThrow(/malformed aggregate/);
  });
});

describe('Firestore document id boundaries', () => {
  it('accepts only SDK-style 20-character auto IDs', () => {
    expect(requireAutoId('Ab3dEf5hIj7kLm9nOpQr')).toBe('Ab3dEf5hIj7kLm9nOpQr');
    expect(encodedAutoId('Ab3dEf5hIj7kLm9nOpQr')).toBe('Ab3dEf5hIj7kLm9nOpQr');
    for (const bad of ['', 'short', '../users/operator', 'A'.repeat(21), 'A'.repeat(19) + '/']) {
      expect(() => requireAutoId(bad)).toThrow(/Invalid document id/);
    }
  });

  it('validates share tokens and generic path segments independently', () => {
    expect(requireShareToken('a'.repeat(64))).toBe('a'.repeat(64));
    expect(() => requireShareToken('../posts/' + 'a'.repeat(64))).toThrow(/Invalid share token id/);
    expect(requireDocumentSegment('owner__Acme%20Studio')).toBe('owner__Acme%20Studio');
    expect(() => requireDocumentSegment('../users')).toThrow();
  });

  it('rejects traversal in every post/automation/share id helper before auth or fetch', async () => {
    const env = {};
    const badAuto = '../users/operator';
    const badShare = '../posts/' + 'a'.repeat(64);
    const calls = [
      () => getPost(env, badAuto),
      () => updatePost(env, badAuto, { title: 'x' }),
      () => deletePost(env, badAuto),
      () => getAutomation(env, badAuto),
      () => updateAutomation(env, badAuto, { enabled: false }),
      () => deleteAutomation(env, badAuto),
      () => getShareDoc(env, badShare),
      () => deleteShareDoc(env, badShare),
    ];
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    for (const call of calls) await expect(call()).rejects.toMatchObject({ code: 'invalid_document_id' });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('update-time optimistic transactions', () => {
  it('puts the live updateTime precondition and feedback append in one commit write', () => {
    const write = buildPostMutationWrite(
      { FIREBASE_PROJECT_ID: 'spool-test' },
      'Ab3dEf5hIj7kLm9nOpQr',
      '2026-08-24T20:00:00.000000Z',
      {
        patch: { approvalStatus: 'changes_requested', updatedAt: '2026-08-24T20:01:00.000Z' },
        append: { field: 'feedbackThread', entry: { text: 'Fix CTA', by: 'client', at: '2026-08-24T20:01:00.000Z' } },
      },
    );
    expect(write.currentDocument).toEqual({ updateTime: '2026-08-24T20:00:00.000000Z' });
    expect(write.update.name).toBe('projects/spool-test/databases/(default)/documents/posts/Ab3dEf5hIj7kLm9nOpQr');
    expect(write.updateTransforms).toHaveLength(1);
    expect(write.updateTransforms[0].fieldPath).toBe('feedbackThread');
  });

  it('re-reads and rebuilds after a concurrent-write conflict', async () => {
    const states = [
      { value: 'old', _updateTime: 't1' },
      { value: 'reviewed', _updateTime: 't2' },
    ];
    const committed = [];
    const result = await runUpdateTimeTransaction({
      read: vi.fn().mockResolvedValueOnce(states[0]).mockResolvedValueOnce(states[1]),
      build: (live, attempt) => ({ patch: { value: live.value, attempt } }),
      commit: async (live, mutation, attempt) => {
        if (attempt === 0) {
          const err = new Error('race');
          err.retryable = true;
          throw err;
        }
        committed.push({ live, mutation });
      },
    });

    expect(result.attempts).toBe(2);
    expect(committed[0]).toEqual({
      live: states[1],
      mutation: { patch: { value: 'reviewed', attempt: 1 } },
    });
  });
});
