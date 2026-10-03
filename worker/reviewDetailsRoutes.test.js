import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(), getUserRecord: vi.fn(), checkRateLimit: vi.fn(), getPost: vi.fn(),
  createPost: vi.fn(), mutatePostAtomically: vi.fn(), listDraftPage: vi.fn(),
  fetchClientRoster: vi.fn(), pushSenderTemplate: vi.fn(), publishDraftToSite: vi.fn(),
  renderSenderPreview: vi.fn(), resolveDraftImage: vi.fn(),
}));
vi.mock('./auth.js', async original => ({ ...await original(), authenticate: mocks.authenticate }));
vi.mock('./firestore.js', async original => ({ ...await original(),
  getUserRecord: mocks.getUserRecord, getPost: mocks.getPost, createPost: mocks.createPost,
  mutatePostAtomically: mocks.mutatePostAtomically, listDraftPage: mocks.listDraftPage,
}));
vi.mock('./ratelimit.js', () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock('./suiteContext.js', async original => ({ ...await original(),
  fetchClientRoster: mocks.fetchClientRoster, pushSenderTemplate: mocks.pushSenderTemplate,
  publishDraftToSite: mocks.publishDraftToSite, renderSenderPreview: mocks.renderSenderPreview,
}));
vi.mock('./media.js', async original => ({ ...await original(), resolveDraftImage: mocks.resolveDraftImage }));
import worker from './index.js';
import { draftPayloadRevision, draftReviewRevision } from './draftUpdate.js';
import { reviewDetailsSnapshot } from '../src/utils/reviewDetails.js';

const origin = 'https://spool.example';
const id = 'A'.repeat(20);
const env = { OWNER_UID: 'operator', ALLOWED_ORIGINS: '*', PUBLIC_ORIGIN: origin, CONTEXT_KEY: 'synthetic' };
const base = () => ({
  id, uid: 'operator', clientId: 'acme', client: 'Acme', content: 'Caption',
  title: 'Title', platform: 'linkedin', imageUrl: '', status: 'draft',
  approvalStatus: 'pending', reviewStage: 'in_review', updatedAt: '2026-10-02T00:00:00.000Z',
});
const detailed = () => ({ ...base(), reviewDetailsVersion: 1, firstComment: ' Exact first comment ',
  reviewMedia: [{ id: 'M'.repeat(20), url: 'https://youtu.be/abcdefghijk', label: 'Cut one', version: 'v1' }] });
const request = (path, method = 'GET', body) => worker.fetch(new Request(`${origin}${path}`, {
  method, ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
}), env, {});
const baseline = async live => ({ baseClientId: live.clientId,
  basePayloadRevision: await draftPayloadRevision(origin, live), baseReviewRevision: await draftReviewRevision(live) });
const human = () => mocks.authenticate.mockResolvedValue({ mode: 'firebase', principal: 'operator' });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticate.mockResolvedValue({ mode: 'apikey', principal: 'internal' });
  mocks.getUserRecord.mockResolvedValue(null);
  mocks.checkRateLimit.mockResolvedValue({ ok: true });
  mocks.getPost.mockResolvedValue(base());
  mocks.fetchClientRoster.mockResolvedValue([{ slug: 'acme', name: 'Acme' }]);
  mocks.resolveDraftImage.mockResolvedValue('https://spool.example/media/v2/generated/operator/test.png');
  mocks.pushSenderTemplate.mockResolvedValue({ status: 200, body: { ok: true } });
  mocks.publishDraftToSite.mockResolvedValue({ status: 200, body: { ok: true } });
  mocks.renderSenderPreview.mockResolvedValue({ status: 200, body: { ok: true, html: '<p>Preview</p>' } });
  mocks.mutatePostAtomically.mockImplementation(async (_env, _id, build) => {
    const live = await mocks.getPost();
    const result = await build(live);
    return { document: { ...live, ...result.patch,
      ...(result.append ? { feedbackThread: [...(live.feedbackThread || []), result.append.entry] } : {}) } };
  });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected provider request')));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('worker routes preserve supplemental fields without authoring them', () => {
  it.each(['firstComment', 'reviewMedia', 'reviewDetailsVersion', 'reviewDetailsAck', 'reviewMediaLinks'])(
    'DELETE refuses protected field presence before any provider operation: %s', async field => {
      mocks.getPost.mockResolvedValue({ ...base(), [field]: null });
      const result = await request(`/api/drafts/${id}`, 'DELETE');
      expect(result.status).toBe(409);
      expect(await result.json()).toMatchObject({ error: 'review_details_maintenance_unsupported' });
      expect(fetch).not.toHaveBeenCalled();
    });
  it('returns all exact public supplemental fields through GET and list', async () => {
    const live = detailed();
    mocks.getPost.mockResolvedValue(live);
    const single = await request(`/api/drafts/${id}`);
    expect(single.status).toBe(200);
    expect((await single.json()).draft).toMatchObject({ reviewDetailsVersion: 1,
      firstComment: live.firstComment, reviewMedia: live.reviewMedia });
    mocks.listDraftPage.mockImplementation(async (_env, _uid, options) => ({
      drafts: [await options.transformRow(live)], total: 1, scanned: 1, seen: 1,
      truncated: false, matched: 1,
    }));
    const list = await request('/api/drafts?clientId=acme');
    expect(list.status).toBe(200);
    expect((await list.json()).drafts[0]).toMatchObject({ reviewMedia: live.reviewMedia, firstComment: live.firstComment });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['GET', 'LIST', 'PATCH'])('gives stable invalid-details refusal for malformed stored fields: %s', async mode => {
    const invalid = { ...base(), firstComment: '' };
    mocks.getPost.mockResolvedValue(invalid);
    mocks.listDraftPage.mockImplementation(async (_env, _uid, options) => {
      await options.transformRow(invalid);
      throw new Error('Malformed row should not be ignored');
    });
    const response = mode === 'LIST' ? await request('/api/drafts')
      : await request(`/api/drafts/${id}`, mode === 'PATCH' ? 'PATCH' : 'GET', mode === 'PATCH' ? { content: 'Edit' } : undefined);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'review_details_invalid' });
    expect(mocks.mutatePostAtomically).not.toHaveBeenCalled();
    expect(mocks.resolveDraftImage).not.toHaveBeenCalled();
  });

  it.each(['firstComment', 'reviewMedia', 'reviewDetailsVersion', 'reviewDetailsAck', 'reviewMediaLinks'])(
    'rejects POST authoring before roster/image/storage: %s', async field => {
      const response = await request('/api/drafts', 'POST', {
        clientId: 'acme', client: 'Acme', content: 'Caption', [field]: null, image: { base64: 'synthetic' },
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'review_details_authoring_disabled' });
      expect(mocks.fetchClientRoster).not.toHaveBeenCalled();
      expect(mocks.resolveDraftImage).not.toHaveBeenCalled();
      expect(mocks.createPost).not.toHaveBeenCalled();
    });

  it.each(['firstComment', 'reviewMedia', 'reviewDetailsVersion', 'reviewMediaLinks'])(
    'rejects PATCH authoring before image/storage: %s', async field => {
      const response = await request(`/api/drafts/${id}`, 'PATCH', {
        ...await baseline(base()), [field]: null, image: { base64: 'synthetic' },
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'review_details_authoring_disabled' });
      expect(mocks.resolveDraftImage).not.toHaveBeenCalled();
      expect(mocks.mutatePostAtomically).not.toHaveBeenCalled();
    });

  it.each(['approved', 'changes_requested', 'pending'])('requires exact acknowledgment on review mutation %s', async approvalStatus => {
    const live = detailed();
    if (approvalStatus === 'pending') live.approvalStatus = 'changes_requested';
    mocks.getPost.mockResolvedValue(live);
    const response = await request(`/api/drafts/${id}`, 'PATCH', {
      ...await baseline(live), approvalStatus, ...(approvalStatus === 'changes_requested' ? { feedback: 'Revise please' } : {}),
    });
    expect(response.status).toBe(428);
    expect(await response.json()).toMatchObject({ error: 'review_details_required' });
    expect(mocks.mutatePostAtomically).not.toHaveBeenCalled();
    expect(mocks.resolveDraftImage).not.toHaveBeenCalled();
  });

  it.each(['approved', 'changes_requested'])('acknowledges exact saved details server-side for %s', async approvalStatus => {
    const live = detailed();
    mocks.getPost.mockResolvedValue(live);
    const response = await request(`/api/drafts/${id}`, 'PATCH', {
      ...await baseline(live), approvalStatus, reviewedBy: 'client',
      reviewDetailsAck: reviewDetailsSnapshot(live), ...(approvalStatus === 'changes_requested' ? { feedback: 'Revise please' } : {}),
    });
    expect(response.status).toBe(200);
    const { draft } = await response.json();
    expect(draft).toMatchObject({ reviewDetailsVersion: 1, firstComment: live.firstComment,
      reviewMedia: live.reviewMedia, approvalStatus, reviewedBy: 'client' });
    expect(draft.reviewDetailsAck).toEqual({ ...reviewDetailsSnapshot(live), at: draft.updatedAt });
    expect(draft.reviewedAt).toBe(draft.updatedAt);
    expect(mocks.mutatePostAtomically).toHaveBeenCalledOnce();
  });

  it('refuses stale observed details and refuses caller-provided stored timestamp', async () => {
    const live = detailed();
    mocks.getPost.mockResolvedValue(live);
    for (const ack of [{ ...reviewDetailsSnapshot(live), firstComment: 'Stale' },
      { ...reviewDetailsSnapshot(live), at: live.updatedAt }]) {
      const response = await request(`/api/drafts/${id}`, 'PATCH', {
        ...await baseline(live), approvalStatus: 'approved', reviewDetailsAck: ack,
      });
      expect(response.status).toBe(428);
      expect(await response.json()).toMatchObject({ error: 'review_details_required' });
    }
    expect(mocks.mutatePostAtomically).not.toHaveBeenCalled();
  });

  it('refuses changed details and tenant on actual CAS retry without overwriting', async () => {
    const live = detailed();
    mocks.getPost.mockResolvedValue(live);
    for (const changed of [{ ...live, firstComment: 'Concurrent edit' }, { ...live, clientId: 'different' }]) {
      mocks.mutatePostAtomically.mockImplementationOnce(async (_env, _id, build) => {
        await build(live); // abandoned first attempt, no commit
        await build(changed); // real retry is refused
        throw new Error('A stale retry must not commit');
      });
      const response = await request(`/api/drafts/${id}`, 'PATCH', {
        ...await baseline(live), approvalStatus: 'approved', reviewDetailsAck: reviewDetailsSnapshot(live),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: 'review_conflict' });
    }
  });

  it('refuses malformed supplemental data introduced before a CAS retry', async () => {
    const live = detailed();
    mocks.getPost.mockResolvedValue(live);
    mocks.mutatePostAtomically.mockImplementationOnce(async (_env, _id, build) => {
      await build(live);
      return build({ ...live, reviewMedia: null });
    });
    const response = await request(`/api/drafts/${id}`, 'PATCH', {
      ...await baseline(live), approvalStatus: 'approved', reviewDetailsAck: reviewDetailsSnapshot(live),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'review_details_invalid' });
  });

  it.each(['private', 'in_review'])('requires observed details for stage-only %s without inventing a review decision', async reviewStage => {
    const live = detailed();
    live.reviewStage = reviewStage === 'private' ? 'in_review' : 'private';
    mocks.getPost.mockResolvedValue(live);
    let response = await request(`/api/drafts/${id}`, 'PATCH', { ...await baseline(live), reviewStage });
    expect(response.status).toBe(428);
    response = await request(`/api/drafts/${id}`, 'PATCH', {
      ...await baseline(live), reviewStage, reviewDetailsAck: reviewDetailsSnapshot(live),
    });
    expect(response.status).toBe(200);
    const { draft } = await response.json();
    expect(draft.reviewStage).toBe(reviewStage);
    expect(draft).not.toHaveProperty('reviewedAt');
    expect(draft).not.toHaveProperty('reviewDetailsAck');
    expect(draft.approvalStatus).toBe('pending');
  });

  it('rejects a supplied acknowledgment on an ordinary patch rather than saving or ignoring it', async () => {
    const live = detailed();
    mocks.getPost.mockResolvedValue(live);
    const response = await request(`/api/drafts/${id}`, 'PATCH', {
      ...await baseline(live), content: 'Changed', reviewDetailsAck: reviewDetailsSnapshot(live),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'review_details_authoring_disabled' });
    expect(mocks.mutatePostAtomically).not.toHaveBeenCalled();
  });

  it('keeps approve isolated from caption edits even when the supplemental acknowledgment is current', async () => {
    const live = detailed();
    mocks.getPost.mockResolvedValue(live);
    const response = await request(`/api/drafts/${id}`, 'PATCH', {
      ...await baseline(live), content: 'Unreviewed edit', approvalStatus: 'approved', reviewDetailsAck: reviewDetailsSnapshot(live),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'mixed_review_edit' });
    expect(mocks.mutatePostAtomically).not.toHaveBeenCalled();
  });

  it('requires a new acknowledgment even after all supplemental controls are cleared', async () => {
    const live = { ...base(), reviewDetailsVersion: 1, firstComment: '', reviewMedia: [] };
    mocks.getPost.mockResolvedValue(live);
    const noAck = await request(`/api/drafts/${id}`, 'PATCH', { ...await baseline(live), approvalStatus: 'approved' });
    expect(noAck.status).toBe(428);
    const approved = await request(`/api/drafts/${id}`, 'PATCH', {
      ...await baseline(live), approvalStatus: 'approved', reviewDetailsAck: reviewDetailsSnapshot(live),
    });
    expect(approved.status).toBe(200);
    const { draft } = await approved.json();
    expect(draft).toMatchObject({ reviewDetailsVersion: 1, firstComment: '', reviewMedia: [] });
    expect(draft.reviewDetailsAck).toMatchObject({ version: 1, firstComment: '', reviewMedia: [] });
  });

  it('retains versioned details and previous acknowledgment on an ordinary caption edit', async () => {
    const live = detailed();
    live.approvalStatus = 'approved';
    live.reviewedAt = live.updatedAt;
    live.reviewDetailsAck = { ...reviewDetailsSnapshot(live), at: live.reviewedAt };
    mocks.getPost.mockResolvedValue(live);
    const response = await request(`/api/drafts/${id}`, 'PATCH', { ...await baseline(live), content: 'Different caption' });
    expect(response.status).toBe(200);
    expect((await response.json()).draft).toMatchObject({ content: 'Different caption', approvalStatus: 'pending',
      reviewDetailsVersion: 1, firstComment: live.firstComment, reviewMedia: live.reviewMedia,
      reviewDetailsAck: live.reviewDetailsAck, reviewedAt: live.reviewedAt });
  });

  it('preserves legacy review mutation with no required or invented supplement fields', async () => {
    const response = await request(`/api/drafts/${id}`, 'PATCH', { ...await baseline(base()), approvalStatus: 'approved' });
    expect(response.status).toBe(200);
    const { draft } = await response.json();
    expect(draft.approvalStatus).toBe('approved');
    expect(draft).not.toHaveProperty('reviewDetailsVersion');
    expect(draft).not.toHaveProperty('reviewDetailsAck');
  });

  it.each(['/api/sender-template', '/api/publish-to-site'])(
    'refuses versioned/cleared/malformed details before %s handoff', async path => {
      human();
      for (const fields of [{ reviewDetailsVersion: 1 }, { firstComment: '' }, { reviewMedia: [] }]) {
        mocks.getPost.mockResolvedValue({ ...base(), platform: 'blog', approvalStatus: 'approved', ...fields });
        const response = await request(path, 'POST', { postId: id });
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: 'review_details_handoff_unsupported' });
      }
      expect(mocks.fetchClientRoster).not.toHaveBeenCalled();
      expect(mocks.pushSenderTemplate).not.toHaveBeenCalled();
      expect(mocks.publishDraftToSite).not.toHaveBeenCalled();
    });

  it('refuses supplemental email-preview fields rather than dropping them', async () => {
    human();
    const response = await request('/api/email-preview', 'POST', { ...detailed() });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'review_details_handoff_unsupported' });
    expect(mocks.fetchClientRoster).not.toHaveBeenCalled();
    expect(mocks.renderSenderPreview).not.toHaveBeenCalled();
  });

  it('leaves legacy Sender handoff and preview working', async () => {
    human();
    mocks.getPost.mockResolvedValue({ ...base(), approvalStatus: 'approved' });
    expect((await request('/api/sender-template', 'POST', { postId: id })).status).toBe(200);
    expect(mocks.pushSenderTemplate).toHaveBeenCalledOnce();
    expect((await request('/api/email-preview', 'POST', base())).status).toBe(200);
    expect(mocks.renderSenderPreview).toHaveBeenCalledOnce();
  });

  it.each(['anonymous', 'member', 'rate'])('retains existing admission gate before reading details: %s', async mode => {
    if (mode === 'anonymous') mocks.authenticate.mockResolvedValue(null);
    if (mode === 'member') mocks.authenticate.mockResolvedValue({ mode: 'firebase', principal: 'member' });
    if (mode === 'rate') mocks.checkRateLimit.mockResolvedValue({ ok: false, limit: 10, scope: 'minute', retryAfter: 20 });
    const response = await request(`/api/drafts/${id}`);
    expect(response.status).toBe({ anonymous: 401, member: 403, rate: 429 }[mode]);
    expect(mocks.getPost).not.toHaveBeenCalled();
  });
});
