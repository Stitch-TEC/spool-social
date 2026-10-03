import { describe, expect, it } from 'vitest';
import { copyReviewDetailsFields, hasReviewDetailsFields, isValidReviewDetails,
  isValidReviewMedia, reviewDetailsSnapshot, reviewDetailsIdentity,
  reviewDetailsAcknowledgmentMatches, REVIEW_DETAILS_PROTECTED_FIELDS,
  hasProtectedReviewDetails, assertLegacyReviewWriter } from './reviewDetails.js';
import { REVIEW_DETAILS_PROTECTED_FIELDS as maintenanceFields,
  hasProtectedReviewDetails as maintenancePresence } from '../../worker/reviewDetails.js';

const media = { id: 'rm01234567890123456789', url: 'https://youtu.be/clip?token=a%2Fb', label: 'Cut one', version: 'v2' };
const post = { reviewDetailsVersion: 1, reviewMedia: [media], firstComment: 'Website: https://example.com/' };

describe('review-only compatibility contract', () => {
  it('matches the privileged maintenance presence boundary without extending the payload contract', () => {
    expect(REVIEW_DETAILS_PROTECTED_FIELDS).toEqual(maintenanceFields);
    expect(Object.isFrozen(REVIEW_DETAILS_PROTECTED_FIELDS)).toBe(true);
    for (const field of ['reviewDetailsAck', 'reviewMediaLinks']) {
      const reserved = { content: 'Caption', [field]: null };
      expect(hasProtectedReviewDetails(reserved)).toBe(true);
      expect(hasReviewDetailsFields(reserved)).toBe(false);
      expect(copyReviewDetailsFields(reserved)).toEqual({});
      expect(reviewDetailsSnapshot(reserved)).toBeNull();
      expect(reviewDetailsIdentity(reserved)).toBe('null');
    }
  });
  it.each(REVIEW_DETAILS_PROTECTED_FIELDS.flatMap(field =>
    [undefined, null, false, 0, '', [], {}].map(value => [field, value])))('fences own %s presence regardless of value %#', (field, value) => {
    const reserved = { [field]: value };
    expect(hasProtectedReviewDetails(reserved)).toBe(true);
    expect(maintenancePresence(reserved)).toBe(true);
    expect(() => assertLegacyReviewWriter(reserved)).toThrow('not enabled');
  });
  it('keeps legacy absence and inherited properties outside the own-field fence', () => {
    for (const value of [null, undefined, [], '', 0, { content: 'Legacy' },
      Object.create({ reviewDetailsAck: null, reviewMediaLinks: [] })]) {
      expect(hasProtectedReviewDetails(value)).toBe(false);
      expect(() => assertLegacyReviewWriter(value)).not.toThrow();
    }
  });
  it('keeps legacy absence distinct from the sticky versioned empty controls', () => {
    expect(isValidReviewDetails({ content: 'Caption' })).toBe(true);
    expect(hasReviewDetailsFields({ content: 'Caption' })).toBe(false);
    expect(copyReviewDetailsFields({ content: 'Caption' })).toEqual({});
    expect(reviewDetailsSnapshot({ content: 'Caption' })).toBeNull();
    expect(reviewDetailsIdentity({ content: 'Caption' })).toBe('null');
    expect(reviewDetailsSnapshot({ reviewDetailsVersion: 1 })).toEqual({ version: 1, firstComment: '', reviewMedia: [] });
  });
  it('copies only known fields, preserving exact strings and ordered items', () => {
    const copied = copyReviewDetailsFields({ ...post, content: 'Unchanged', secret: 'excluded' });
    expect(copied).toEqual(post);
    expect(copied.reviewMedia).not.toBe(post.reviewMedia);
    expect(copied.reviewMedia[0]).not.toBe(media);
    expect(reviewDetailsSnapshot(post).firstComment).toBe(post.firstComment);
  });
  it.each([null, [], 'text', { firstComment: '' }, { reviewMedia: [] },
    { reviewDetailsVersion: 0 }, { reviewDetailsVersion: '1' },
    { reviewDetailsVersion: 1, firstComment: null },
    { reviewDetailsVersion: 1, firstComment: 'x'.repeat(4001) },
    { reviewDetailsVersion: 1, reviewMedia: null }])('rejects malformed extension %#', value => {
    expect(isValidReviewDetails(value)).toBe(false);
    expect(() => copyReviewDetailsFields(value)).toThrow();
  });
  it('accepts exact limits without slicing', () => {
    expect(isValidReviewDetails({ ...post, firstComment: 'x'.repeat(4000) })).toBe(true);
    expect(isValidReviewMedia([{ ...media, id: 'x'.repeat(80), label: 'x'.repeat(120), version: 'x'.repeat(80) }])).toBe(true);
  });
  it.each([
    [{ ...media, id: 'short' }], [{ ...media, id: 'x'.repeat(81) }],
    [{ ...media, label: 'x'.repeat(121) }], [{ ...media, version: 'x'.repeat(81) }],
    [{ ...media, extra: true }], [{ id: media.id, url: media.url, label: '' }],
    [{ ...media, url: 'HTTPS://YOUTU.BE:443/clip' }],
    [{ ...media, url: 'https://localhost/clip.mp4' }],
    [{ ...media, url: 'javascript:alert(1)' }],
    [media, { ...media, id: 'different012345678901' }],
    [media, { ...media, url: 'https://youtu.be/other' }],
    Array.from({ length: 6 }, (_, i) => ({ ...media, id: `id0123456789012345678${i}`, url: `https://youtu.be/${i}` })),
  ])('rejects unsafe, duplicate or oversized media %#', value => expect(isValidReviewMedia(value)).toBe(false));
  it('requires an exact explicit acknowledgment, not just the payload hash', () => {
    const ack = reviewDetailsSnapshot(post);
    expect(reviewDetailsAcknowledgmentMatches(ack, post)).toBe(true);
    expect(reviewDetailsAcknowledgmentMatches({ ...ack, at: 'old' }, post)).toBe(false);
    expect(reviewDetailsAcknowledgmentMatches({ ...ack, firstComment: 'other' }, post)).toBe(false);
    expect(reviewDetailsAcknowledgmentMatches({ ...ack, reviewMedia: [{ ...media, version: 'v3' }] }, post)).toBe(false);
    expect(reviewDetailsAcknowledgmentMatches(ack, {})).toBe(false);
    expect(reviewDetailsAcknowledgmentMatches(null, post)).toBe(false);
  });
});
