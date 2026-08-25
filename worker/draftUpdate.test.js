import { describe, expect, it, vi } from 'vitest';
import { runUpdateTimeTransaction } from './firestore.js';
import {
  assertIsolatedDraftReviewIntent,
  assertDraftBaseline,
  buildDraftMutation,
  draftPayloadRevision,
  draftReviewRevision,
  draftApprovedPayloadChanged,
  nextDraftUpdatedAt,
  publicationPathMatchesSlug,
  sameLegacyImageBytes,
  versionDraftMedia,
} from './draftUpdate.js';

const origin = 'https://spool.example';

describe('draft API media canonicalization', () => {
  it('versions imageUrl and rendered Markdown, emits CAS revisions, and hides REST metadata', async () => {
    const output = await versionDraftMedia(origin, {
      id: 'A'.repeat(20),
      _updateTime: 'server-only',
      operatorSecret: 'must-not-cross-api',
      clientId: 'acme',
      imageUrl: '/media/v2/generated/o/a.png',
      content: '![inline](/media/v2/generated/o/b.png) prose /media/v2/ stays',
    });
    expect(output).toEqual(expect.objectContaining({
      id: 'A'.repeat(20),
      clientId: 'acme',
      imageUrl: `${origin}/media/v2/generated/o/a.png`,
      content: `![inline](${origin}/media/v2/generated/o/b.png) prose /media/v2/ stays`,
      payloadRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
      reviewRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
      title: '',
      platform: '',
      altText: '',
      metaDescription: '',
      slug: '',
    }));
    expect(output).not.toHaveProperty('_updateTime');
    expect(output).not.toHaveProperty('operatorSecret');
  });

  it('recognizes identical legacy data bytes as a storage migration', () => {
    const png = 'iVBORw0KGgo=';
    expect(sameLegacyImageBytes(`data:image/png;base64,${png}`, { base64: png, mime: 'image/png' })).toBe(true);
    expect(sameLegacyImageBytes(`data:image/png;base64,${png}`, { base64: 'iVBORw0KGgs=', mime: 'image/png' })).toBe(false);
  });

  it('normalizes only recognized Spool payload references', () => {
    expect(draftApprovedPayloadChanged(origin,
      { content: `![x](${origin}/media/a.png)`, imageUrl: `${origin}/media/a.png` },
      { content: `![x](${origin}/media/v2/a.png)`, imageUrl: `${origin}/media/v2/a.png` }
    )).toBe(false);
    expect(draftApprovedPayloadChanged(origin,
      { content: 'prose /media/a.png', imageUrl: 'https://cdn.example/media/a.png' },
      { content: 'prose /media/v2/a.png', imageUrl: 'https://cdn.example/media/v2/a.png' }
    )).toBe(true);
  });

  it('keeps missing and empty optional approval fields digest-equivalent', async () => {
    const legacy = { content: 'Copy', title: 'Title', imageUrl: '', platform: 'blog' };
    const normalized = { ...legacy, altText: '', metaDescription: '', slug: '' };
    await expect(draftPayloadRevision(origin, legacy)).resolves.toBe(await draftPayloadRevision(origin, normalized));
    await expect(versionDraftMedia(origin, legacy)).resolves.toMatchObject({
      title: 'Title', altText: '', metaDescription: '', imageUrl: '', slug: 'title',
    });
  });

  it('derives a visible stable publication target for punctuation-only legacy titles', async () => {
    await expect(versionDraftMedia(origin, {
      platform: 'blog', title: '🔥🔥', content: '', imageUrl: '',
    })).resolves.toMatchObject({ slug: 'untitled-post' });
  });

  it('binds a publish override to the approved slug basename', () => {
    expect(publicationPathMatchesSlug('content/posts/approved-path.mdx', 'approved-path')).toBe(true);
    expect(publicationPathMatchesSlug('content/posts/different-path.md', 'approved-path')).toBe(false);
    expect(publicationPathMatchesSlug('../approved-path.html', 'approved-path')).toBe(false);
  });
});

describe('draft API optimistic review preservation', () => {
  it('matches browser Date/Timestamp-like schedules to the raw Firestore ISO revision', async () => {
    const iso = '2026-09-01T12:00:00.123Z';
    const base = { status: 'draft', approvalStatus: 'pending', reviewStage: 'in_review' };
    const raw = await draftReviewRevision({ ...base, scheduledDate: iso });
    await expect(draftReviewRevision({ ...base, scheduledDate: new Date(iso) })).resolves.toBe(raw);
    await expect(draftReviewRevision({ ...base, scheduledDate: { toDate: () => new Date(iso) } })).resolves.toBe(raw);
    expect(() => draftReviewRevision({ ...base, scheduledDate: 'not-a-date' }))
      .toThrow(expect.objectContaining({ code: 'review_date_invalid' }));
  });

  it('requires edits and review verbs to be separate baseline-bound requests', () => {
    for (const body of [
      { content: 'Unseen replacement', approvalStatus: 'approved' },
      { title: 'Unseen title', approvalStatus: 'changes_requested' },
      { platform: 'linkedin', approvalStatus: 'approved' },
      { imageUrl: '/media/v2/new.png', reviewStage: 'in_review' },
      { image: { base64: 'abc' }, approvalStatus: 'approved' },
    ]) {
      expect(() => assertIsolatedDraftReviewIntent(body, {
        hasApproval: body.approvalStatus !== undefined,
        hasReviewStage: body.reviewStage !== undefined,
        hasStatus: false,
      })).toThrow(expect.objectContaining({ code: 'mixed_review_edit', status: 400 }));
    }
    expect(() => assertIsolatedDraftReviewIntent({ reviewStage: 'private', status: 'archived' }, {
      hasApproval: false, hasReviewStage: true, hasStatus: true,
    })).toThrow(expect.objectContaining({ code: 'mixed_review_edit' }));
    expect(assertIsolatedDraftReviewIntent({ approvalStatus: 'approved', status: 'scheduled' }, {
      hasApproval: true, hasReviewStage: false, hasStatus: true,
    })).toBe(true);
  });

  it('rejects tenant/content/review drift against the caller baseline', async () => {
    const baseline = {
      clientId: 'acme', content: 'Copy', title: 'Title', imageUrl: '/media/v2/a.png',
      platform: 'gmb',
      status: 'draft', approvalStatus: 'pending', reviewStage: 'in_review', feedbackThread: [],
    };
    const token = {
      clientId: baseline.clientId,
      payloadRevision: await draftPayloadRevision(origin, baseline),
      reviewRevision: await draftReviewRevision(baseline),
    };
    await expect(assertDraftBaseline(origin, baseline, token, [], { review: true })).resolves.toBe(true);
    await expect(assertDraftBaseline(origin, { ...baseline, clientId: 'beta' }, token))
      .rejects.toMatchObject({ code: 'review_conflict', status: 409 });
    await expect(assertDraftBaseline(origin, { ...baseline, content: 'Changed' }, token))
      .rejects.toMatchObject({ code: 'review_conflict' });
    await expect(assertDraftBaseline(origin, { ...baseline, platform: 'linkedin' }, token))
      .rejects.toMatchObject({ code: 'review_conflict' });
    for (const [field, value] of [
      ['altText', 'New alt'],
      ['metaDescription', 'New description'],
      ['slug', 'new-publication-path'],
    ]) {
      await expect(assertDraftBaseline(origin, { ...baseline, [field]: value }, token))
        .rejects.toMatchObject({ code: 'review_conflict', status: 409 });
    }
    await expect(assertDraftBaseline(origin, { ...baseline, approvalStatus: 'approved' }, token, [], { review: true }))
      .rejects.toMatchObject({ code: 'review_conflict' });
  });

  it('rebuilds after a racing approval, preserves status/history, and resets only changed payload', async () => {
    const before = {
      content: 'Old copy', title: 'Title', imageUrl: '', status: 'draft',
      approvalStatus: 'pending', feedbackThread: [],
      createdAt: '2026-08-24T19:00:00.000Z', updatedAt: '2026-08-24T19:00:00.000Z',
      _updateTime: 't1',
    };
    const afterRace = {
      ...before,
      status: 'posted',
      approvalStatus: 'approved',
      feedback: 'Concurrent note',
      feedbackThread: [{ text: 'Concurrent note', by: 'client', at: '2026-08-24T20:00:00.000Z' }],
      updatedAt: '2026-08-24T20:00:00.000Z',
      _updateTime: 't2',
    };
    const commits = [];
    const now = vi.fn().mockReturnValueOnce(Date.parse('2026-08-24T19:30:00Z'))
      .mockReturnValue(Date.parse('2026-08-24T20:30:00Z'));

    await runUpdateTimeTransaction({
      read: vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(afterRace),
      build: (live) => buildDraftMutation(origin, live, {
        fields: { content: 'Changed copy' },
        hasStatus: true,
        status: 'draft',
        baseStatus: 'draft',
        hasApproval: false,
        hasReviewStage: false,
      }, now()),
      commit: async (live, mutation, attempt) => {
        if (attempt === 0) {
          const err = new Error('race'); err.retryable = true; throw err;
        }
        commits.push({ live, mutation });
      },
    });

    const final = commits[0].mutation;
    expect(final.patch).toMatchObject({
      content: 'Changed copy',
      approvalStatus: 'pending',
      updatedAt: '2026-08-24T20:30:00.000Z',
    });
    expect(final.patch).not.toHaveProperty('status');
    expect(final.patch).not.toHaveProperty('feedback');
    expect(final.patch).not.toHaveProperty('feedbackThread');
    expect(final.append).toBeNull();
    expect(commits[0].live.feedbackThread).toHaveLength(1);
  });

  it('preserves approval for a no-op cache migration and timestamps after live state', () => {
    const live = {
      content: `![x](${origin}/media/a.png)`,
      title: 'Title',
      imageUrl: `${origin}/media/a.png`,
      approvalStatus: 'approved',
      createdAt: '2026-08-24T21:00:00.000Z',
      updatedAt: '2026-08-24T21:00:01.000Z',
    };
    const mutation = buildDraftMutation(origin, live, {
      fields: {
        content: `![x](${origin}/media/v2/a.png)`,
        imageUrl: `${origin}/media/v2/a.png`,
      },
      hasStatus: false,
      hasApproval: false,
      hasReviewStage: false,
    }, Date.parse('2026-08-24T20:00:00Z'));

    expect(mutation.payloadChanged).toBe(false);
    expect(mutation.patch).not.toHaveProperty('approvalStatus');
    expect(mutation.patch.updatedAt).toBe('2026-08-24T21:00:01.001Z');
    expect(nextDraftUpdatedAt(live, 0)).toBe('2026-08-24T21:00:01.001Z');
  });

  it('resets approval when an ordinary worker edit changes platform', () => {
    const live = {
      content: 'Same copy', title: 'Title', imageUrl: '', platform: 'gmb',
      approvalStatus: 'approved', createdAt: '2026-08-24T21:00:00.000Z',
    };
    const mutation = buildDraftMutation(origin, live, {
      fields: { platform: 'linkedin' },
      hasStatus: false,
      hasApproval: false,
      hasReviewStage: false,
    });
    expect(mutation.payloadChanged).toBe(true);
    expect(mutation.patch).toMatchObject({ platform: 'linkedin', approvalStatus: 'pending' });
  });

  it.each([
    ['altText', 'New alt text'],
    ['metaDescription', 'New SEO description'],
    ['slug', 'new-publication-path'],
  ])('resets approval when an ordinary worker edit changes %s', (field, value) => {
    const live = {
      content: 'Same copy', title: 'Title', imageUrl: '', platform: 'blog',
      altText: '', metaDescription: '', slug: 'old-path',
      approvalStatus: 'approved', createdAt: '2026-08-24T21:00:00.000Z',
    };
    const mutation = buildDraftMutation(origin, live, {
      fields: { [field]: value },
      hasStatus: false,
      hasApproval: false,
      hasReviewStage: false,
    });
    expect(mutation.payloadChanged).toBe(true);
    expect(mutation.patch).toMatchObject({ [field]: value, approvalStatus: 'pending' });
  });

  it('binds schedule only to the review revision and leaves internal tags outside both revisions', async () => {
    const live = {
      content: 'Copy', title: '', imageUrl: '', platform: 'gmb',
      scheduledDate: '', tags: ['internal-a'],
    };
    expect(await draftPayloadRevision(origin, { ...live, scheduledDate: '2026-09-01T12:00:00.000Z' }))
      .toBe(await draftPayloadRevision(origin, live));
    expect(await draftReviewRevision({ ...live, tags: ['internal-b'] }))
      .toBe(await draftReviewRevision(live));
    expect(await draftReviewRevision({ ...live, scheduledDate: '2026-09-01T12:00:00.000Z' }))
      .not.toBe(await draftReviewRevision(live));
  });

  it('preserves approval when identical legacy bytes are rehosted', () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    const live = {
      content: 'Copy', title: 'Title', imageUrl: dataUrl,
      approvalStatus: 'approved', createdAt: '2026-08-24T21:00:00.000Z',
    };
    const mutation = buildDraftMutation(origin, live, {
      fields: { imageUrl: `${origin}/media/v2/generated/internal/hash.png` },
      migratedImageFrom: dataUrl,
      hasStatus: false,
      hasApproval: false,
      hasReviewStage: false,
    }, Date.parse('2026-08-24T22:00:00Z'));
    expect(mutation.payloadChanged).toBe(false);
    expect(mutation.patch).not.toHaveProperty('approvalStatus');
  });

  it('rebuilds feedback entry timestamps and appends instead of replacing history', () => {
    const live = {
      content: 'Copy', title: '', imageUrl: '', status: 'posted',
      approvalStatus: 'pending',
      reviewStage: 'in_review',
      feedbackThread: [{ text: 'Earlier', by: 'client', at: '2026-08-24T18:00:00.000Z' }],
      createdAt: '2026-08-24T17:00:00.000Z', updatedAt: '2026-08-24T20:00:00.000Z',
    };
    const mutation = buildDraftMutation(origin, live, {
      fields: {},
      hasStatus: true,
      status: 'scheduled',
      hasApproval: true,
      approvalStatus: 'changes_requested',
      feedback: 'New note',
      reviewedBy: 'client',
      reviewAction: 'request_changes',
      hasReviewStage: false,
    }, Date.parse('2026-08-24T20:10:00Z'));

    expect(mutation.patch).not.toHaveProperty('feedbackThread');
    expect(mutation.append.entry).toEqual({
      text: 'New note', by: 'client', at: mutation.patch.updatedAt,
    });
    expect(mutation.patch).toMatchObject({
      reviewedBy: 'client', reviewedAt: mutation.patch.updatedAt,
    });
    // Coupled review status never rewinds an already-posted post to scheduled.
    expect(mutation.patch).not.toHaveProperty('status');
  });

  it('stores accepted feedback exactly and rejects archived approvals', () => {
    const exact = '  Keep this punctuation!  ';
    const live = {
      content: 'Copy', status: 'draft', approvalStatus: 'pending', reviewStage: 'in_review',
      feedbackThread: [], createdAt: '2026-08-24T17:00:00.000Z',
    };
    const mutation = buildDraftMutation(origin, live, {
      fields: {}, hasStatus: false, hasApproval: true, hasReviewStage: false,
      approvalStatus: 'changes_requested', feedback: exact, reviewedBy: 'client',
      reviewAction: 'request_changes',
    });
    expect(mutation.patch.feedback).toBe(exact);
    expect(mutation.append.entry.text).toBe(exact);

    expect(() => buildDraftMutation(origin, { ...live, status: 'archived' }, {
      fields: {}, hasStatus: false, hasApproval: true, hasReviewStage: false,
      approvalStatus: 'approved', reviewAction: 'approve',
    })).toThrow(expect.objectContaining({ code: 'review_conflict', status: 409 }));
  });

  it('refuses to bypass the 200-entry review-history ceiling', () => {
    const live = {
      content: 'Copy', status: 'draft', approvalStatus: 'pending',
      reviewStage: 'in_review',
      feedbackThread: Array.from({ length: 200 }, (_, i) => ({ text: String(i) })),
    };
    expect(() => buildDraftMutation(origin, live, {
      fields: {}, hasStatus: false, hasReviewStage: false, hasApproval: true,
      approvalStatus: 'changes_requested', feedback: 'One too many', reviewedBy: 'client',
      reviewAction: 'request_changes',
    })).toThrow(expect.objectContaining({ code: 'feedback_thread_full', status: 409 }));
  });

  it('enforces centralized send/hold/resubmit state transitions', () => {
    const baseIntent = { fields: {}, hasStatus: false, hasApproval: false, hasReviewStage: true };
    expect(() => buildDraftMutation(origin, {
      content: 'Copy', approvalStatus: 'pending', reviewStage: 'in_review',
    }, { ...baseIntent, reviewStage: 'in_review', reviewAction: 'send' }))
      .toThrow(expect.objectContaining({ code: 'review_conflict' }));
    expect(() => buildDraftMutation(origin, {
      content: 'Copy', approvalStatus: 'pending', reviewStage: 'private',
    }, { ...baseIntent, reviewStage: 'private', reviewAction: 'hold' }))
      .toThrow(expect.objectContaining({ code: 'review_conflict' }));
    expect(() => buildDraftMutation(origin, {
      content: 'Copy', approvalStatus: 'approved', reviewStage: 'in_review',
    }, {
      fields: {}, hasStatus: false, hasApproval: true, approvalStatus: 'pending',
      hasReviewStage: false, reviewAction: 'resubmit',
    })).toThrow(expect.objectContaining({ code: 'review_conflict' }));

    const resubmit = buildDraftMutation(origin, {
      content: 'Copy', approvalStatus: 'changes_requested', feedback: 'Fix it',
      reviewStage: 'in_review', feedbackThread: [{ text: 'Fix it' }],
    }, {
      fields: {}, hasStatus: false, hasApproval: true, approvalStatus: 'pending',
      hasReviewStage: false, reviewAction: 'resubmit',
    });
    expect(resubmit.patch).toMatchObject({
      approvalStatus: 'pending', feedback: '', reviewStage: 'in_review',
    });
    expect(resubmit.patch).not.toHaveProperty('feedbackThread');
  });
});
