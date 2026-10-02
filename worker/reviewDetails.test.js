import { describe, expect, it } from 'vitest';
import {
  assertObservedReviewDetails,
  assertReviewDetailsAuthoringDisabled,
  assertReviewDetailsHandoffSupported,
  assertStoredReviewDetails,
} from './reviewDetails.js';
import {
  buildDraftMutation, draftApprovedPayloadChanged, draftPayloadIdentity,
  draftPayloadRevision, draftReviewIdentity, draftReviewRevision,
  publicDraftFields, versionDraftMedia,
} from './draftUpdate.js';
import { buildDraftListStructuredQuery } from './firestore.js';
import { reviewDetailsSnapshot } from '../src/utils/reviewDetails.js';

const origin = 'https://spool.example';
const media = (id = 'A'.repeat(20), url = 'https://youtu.be/abcdefghijk') => ({
  id, url, label: 'CT scan first cut', version: 'version 1',
});
const base = () => ({
  id: 'P'.repeat(20), uid: 'operator', clientId: 'acme', client: 'Acme',
  content: 'Approved caption', title: 'Title', imageUrl: '', platform: 'linkedin',
  status: 'draft', approvalStatus: 'approved', reviewStage: 'in_review',
  updatedAt: '2026-10-02T12:00:00.000Z',
});
const detailed = () => ({ ...base(), reviewDetailsVersion: 1,
  firstComment: ' Exact comment\n', reviewMedia: [media()] });
const reviewIntent = (live, action = 'approve') => ({
  fields: {}, hasApproval: true, isReviewIntent: true, reviewAction: action,
  approvalStatus: action === 'approve' ? 'approved' : 'changes_requested',
  reviewedBy: 'client', reviewDetailsAck: reviewDetailsSnapshot(live), feedback: 'Change the ending',
});

describe('worker supplemental review compatibility contract', () => {
  it('preserves legacy payload and review identity bytes exactly', () => {
    expect(draftPayloadIdentity(origin, base())).toBe(
      JSON.stringify(['Approved caption', 'Title', '', 'linkedin', '', '', '']));
    expect(draftReviewIdentity(base())).toBe(
      JSON.stringify(['draft', 'approved', 'in_review', '', '', null, '', '', '']));
    expect(publicDraftFields(base())).not.toHaveProperty('reviewDetailsVersion');
  });

  it('preserves exact strings, item order, field absence, and marker-only records in reads', async () => {
    const live = detailed();
    const out = await versionDraftMedia(origin, { ...live, operatorSecret: 'not public' });
    expect(out).toMatchObject({ reviewDetailsVersion: 1,
      firstComment: live.firstComment, reviewMedia: live.reviewMedia });
    expect(out).not.toHaveProperty('operatorSecret');
    const marker = await versionDraftMedia(origin, { ...base(), reviewDetailsVersion: 1 });
    expect(marker).toHaveProperty('reviewDetailsVersion', 1);
    expect(marker).not.toHaveProperty('firstComment');
    expect(marker).not.toHaveProperty('reviewMedia');
    expect(buildDraftListStructuredQuery('operator').select.fields).toEqual(expect.arrayContaining([
      { fieldPath: 'reviewMedia' }, { fieldPath: 'firstComment' },
      { fieldPath: 'reviewDetailsVersion' }, { fieldPath: 'reviewDetailsAck' },
    ]));
  });

  it.each([
    { firstComment: '' }, { reviewMedia: [] }, { reviewDetailsVersion: 0 },
    { reviewDetailsVersion: 1, firstComment: null },
    { reviewDetailsVersion: 1, firstComment: 'x'.repeat(4001) },
    { reviewDetailsVersion: 1, reviewMedia: null },
    { reviewDetailsVersion: 1, reviewMedia: [media('short')] },
    { reviewDetailsVersion: 1, reviewMedia: [{ ...media(), extra: 'ignored?' }] },
    { reviewDetailsVersion: 1, reviewMedia: [{ ...media(), url: 'http://youtu.be/abcdefghijk' }] },
    { reviewDetailsVersion: 1, reviewMedia: [{ ...media(), url: 'https://YOUTU.BE/abcdefghijk' }] },
    { reviewDetailsVersion: 1, reviewMedia: [{ ...media(), label: 'x'.repeat(121) }] },
    { reviewDetailsVersion: 1, reviewMedia: [{ ...media(), version: 'x'.repeat(81) }] },
    { reviewDetailsVersion: 1, reviewMedia: [media(), media()] },
    { reviewDetailsVersion: 1, reviewMedia: [media(), media('B'.repeat(20))] },
    { reviewDetailsVersion: 1, reviewMedia: Array.from({ length: 6 }, (_, i) => media(String(i).repeat(20), `https://youtu.be/video${i}`)) },
  ])('rejects malformed stored extension rather than dropping it: %j', async fields => {
    expect(() => publicDraftFields({ ...base(), ...fields }))
      .toThrow(expect.objectContaining({ code: 'review_details_invalid', status: 400 }));
    await expect(versionDraftMedia(origin, { ...base(), ...fields }))
      .rejects.toThrow(expect.objectContaining({ code: 'review_details_invalid' }));
  });

  it('binds exact supplemental content, order, marker and labels to the payload revision', async () => {
    const live = detailed();
    const revision = await draftPayloadRevision(origin, live);
    for (const next of [
      { ...live, firstComment: live.firstComment.trim() },
      { ...live, reviewMedia: [{ ...media(), label: 'Different label' }] },
      { ...live, reviewMedia: [] },
      { ...base(), reviewDetailsVersion: 1 },
      base(),
    ]) {
      expect(await draftPayloadRevision(origin, next)).not.toBe(revision);
      expect(draftApprovedPayloadChanged(origin, live, next)).toBe(true);
    }
    const withTwo = { ...live, reviewMedia: [media(), media('B'.repeat(20), 'https://youtu.be/anotherclip')] };
    expect(await draftPayloadRevision(origin, withTwo)).not.toBe(
      await draftPayloadRevision(origin, { ...withTwo, reviewMedia: [...withTwo.reviewMedia].reverse() }));
    expect(await draftPayloadRevision(origin, { ...base(), reviewDetailsVersion: 1 })).not.toBe(
      await draftPayloadRevision(origin, base()));
  });

  it.each(['firstComment', 'reviewMedia', 'reviewDetailsVersion', 'reviewDetailsAck', 'reviewMediaLinks'])(
    'rejects new metadata authoring in ordinary create/update: %s', field => {
      expect(() => assertReviewDetailsAuthoringDisabled({ [field]: null }))
        .toThrow(expect.objectContaining({ code: 'review_details_authoring_disabled' }));
      expect(() => buildDraftMutation(origin, detailed(), { fields: { [field]: null } }))
        .toThrow(expect.objectContaining({ code: 'review_details_authoring_disabled' }));
    });

  it('requires current observed details without accepting server-owned at or missing fields', () => {
    const live = detailed();
    for (const ack of [undefined, null, {}, { version: 1 },
      { ...reviewDetailsSnapshot(live), at: '2026-10-02T00:00:00.000Z' },
      { ...reviewDetailsSnapshot(live), firstComment: 'Different' },
      { ...reviewDetailsSnapshot(live), reviewMedia: [] }]) {
      expect(() => assertObservedReviewDetails(live, ack))
        .toThrow(expect.objectContaining({ code: 'review_details_required', status: 428 }));
    }
    expect(assertObservedReviewDetails(live, reviewDetailsSnapshot(live))).toEqual(reviewDetailsSnapshot(live));
    expect(assertObservedReviewDetails(base(), undefined)).toBeNull();
    expect(() => assertObservedReviewDetails(base(), reviewDetailsSnapshot(live)))
      .toThrow(expect.objectContaining({ code: 'review_details_invalid' }));
  });

  it.each(['approve', 'request_changes'])('server stamps exact current details for %s', action => {
    const live = detailed();
    const result = buildDraftMutation(origin, live, reviewIntent(live, action), Date.parse('2026-10-02T12:01:00.000Z'));
    expect(result.patch.reviewDetailsAck).toEqual({ ...reviewDetailsSnapshot(live), at: result.patch.updatedAt });
    expect(result.patch.reviewedAt).toBe(result.patch.updatedAt);
    expect(result.patch.reviewedBy).toBe('client');
    expect(result.patch).not.toHaveProperty('reviewMedia');
    expect(result.patch).not.toHaveProperty('firstComment');
  });

  it('keeps supplements during caption edits while resetting existing approval', () => {
    const live = detailed();
    const result = buildDraftMutation(origin, live, { fields: { content: 'Changed caption' } });
    expect(result.patch.approvalStatus).toBe('pending');
    expect(result.patch).not.toHaveProperty('reviewDetailsVersion');
    expect(result.patch).not.toHaveProperty('reviewDetailsAck');
    expect({ ...live, ...result.patch }).toMatchObject({ firstComment: live.firstComment, reviewMedia: live.reviewMedia });
  });

  it('binds stored ack into review revision and accepts an older ack after an ordinary caption edit', async () => {
    const live = detailed();
    const result = buildDraftMutation(origin, live, reviewIntent(live));
    const reviewed = { ...live, ...result.patch };
    const withoutAck = { ...reviewed };
    delete withoutAck.reviewDetailsAck;
    expect(await draftReviewRevision(reviewed)).not.toBe(await draftReviewRevision(withoutAck));
    expect(() => assertStoredReviewDetails({ ...reviewed, content: 'New caption', approvalStatus: 'pending', updatedAt: '2026-10-03T00:00:00.000Z' })).not.toThrow();
    expect(() => assertStoredReviewDetails({ ...reviewed, reviewDetailsAck: { ...reviewed.reviewDetailsAck, extra: true } }))
      .toThrow(expect.objectContaining({ code: 'review_details_invalid' }));
    expect(() => assertStoredReviewDetails({ ...reviewed, reviewedAt: 'different' }))
      .toThrow(expect.objectContaining({ code: 'review_details_invalid' }));
  });

  it('rechecks acknowledgment against the current live payload on a retry', () => {
    const live = detailed();
    const intent = reviewIntent(live);
    expect(() => buildDraftMutation(origin, { ...live, firstComment: 'Concurrent revision' }, intent))
      .toThrow(expect.objectContaining({ code: 'review_details_required' }));
    expect(() => buildDraftMutation(origin, { ...live, reviewMedia: [] }, intent))
      .toThrow(expect.objectContaining({ code: 'review_details_required' }));
  });

  it.each([{ reviewDetailsVersion: 1 }, { firstComment: '' }, { reviewMedia: [] }, { reviewDetailsAck: null }])(
    'refuses every supplemental-bearing handoff including cleared/invalid fields', fields => {
      expect(() => assertReviewDetailsHandoffSupported({ ...base(), ...fields }))
        .toThrow(expect.objectContaining({ code: 'review_details_handoff_unsupported', status: 409 }));
      expect(() => assertReviewDetailsHandoffSupported(base())).not.toThrow();
    });
});
