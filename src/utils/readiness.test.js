import { describe, it, expect } from 'vitest';
import { postReadiness, hasBlockers, needsImage, isOverdue, effectiveLength } from './readiness';

const post = (over = {}) => ({
  platform: 'linkedin',
  content: 'Something worth saying.',
  scheduledDate: new Date('2099-01-01T00:00:00Z'),
  ...over,
});

describe('postReadiness — blockers', () => {
  it('flags empty content', () => {
    expect(postReadiness(post({ content: '   ' })).blockers).toContain('empty');
  });

  it('flags content over the platform limit', () => {
    expect(postReadiness(post({ platform: 'twitter', content: 'a'.repeat(281) })).blockers).toContain('over_limit');
  });

  it('uses X’s WEIGHTED count, not raw length', () => {
    // A URL counts as 23 regardless of its real length — a raw-length check
    // would wrongly block a tweet the editor accepts.
    const tweet = { platform: 'twitter', content: `Read it: ${'https://example.com/' + 'x'.repeat(300)}` };
    expect(effectiveLength(tweet.content, 'twitter')).toBeLessThan(281);
    expect(postReadiness(post(tweet)).blockers).not.toContain('over_limit');
  });

  it('treats a missing image as a BLOCKER only on an image-first channel', () => {
    expect(postReadiness(post({ platform: 'instagram', imageUrl: '' })).blockers).toContain('image_missing');
    expect(postReadiness(post({ platform: 'gmb', imageUrl: '' })).blockers).not.toContain('image_missing');
    expect(postReadiness(post({ platform: 'gmb', imageUrl: '' })).warnings).toContain('image_suggested');
    expect(postReadiness(post({ platform: 'linkedin', imageUrl: '' })).warnings).not.toContain('image_suggested');
  });
});

describe('postReadiness — warnings', () => {
  it('flags an image with no alt text', () => {
    expect(postReadiness(post({ imageUrl: 'https://x/y.jpg' })).warnings).toContain('no_alt');
    expect(postReadiness(post({ imageUrl: 'https://x/y.jpg', altText: 'A photo' })).warnings).not.toContain('no_alt');
  });

  it('flags an unscheduled post, but never an evergreen template', () => {
    expect(postReadiness(post({ scheduledDate: null })).warnings).toContain('no_date');
    expect(postReadiness(post({ scheduledDate: null, isTemplate: true })).warnings).not.toContain('no_date');
  });

  it('flags missing long-form fields only on long-form platforms', () => {
    const blog = postReadiness(post({ platform: 'blog', title: '', metaDescription: '' })).warnings;
    expect(blog).toContain('no_title');
    expect(blog).toContain('no_meta');
    // A job posting wants a title but has no meta-description concept.
    const job = postReadiness(post({ platform: 'job', title: '', metaDescription: '' })).warnings;
    expect(job).toContain('no_title');
    expect(job).not.toContain('no_meta');
    expect(postReadiness(post({ platform: 'linkedin', title: '' })).warnings).not.toContain('no_title');
  });
});

describe('hasBlockers / needsImage', () => {
  it('separates "cannot go out" from "should be better"', () => {
    expect(hasBlockers(post({ platform: 'gmb', imageUrl: '' }))).toBe(false); // warning only
    expect(hasBlockers(post({ platform: 'instagram', imageUrl: '' }))).toBe(true);
  });

  it('needsImage covers required AND recommended channels, never optional ones', () => {
    expect(needsImage({ platform: 'instagram' })).toBe(true);
    expect(needsImage({ platform: 'gmb' })).toBe(true);
    expect(needsImage({ platform: 'twitter' })).toBe(false);
    expect(needsImage({ platform: 'gmb', imageUrl: 'https://x/y.jpg' })).toBe(false);
  });

  it('never throws on a malformed doc', () => {
    expect(() => postReadiness(null)).not.toThrow();
    expect(postReadiness(null)).toEqual({ blockers: [], warnings: [] });
    expect(needsImage(null)).toBe(false);
  });
});

describe('isOverdue', () => {
  const now = Date.parse('2026-08-18T00:00:00Z');

  it('is true for a past schedule that is still not posted', () => {
    expect(isOverdue({ scheduledDate: new Date('2026-08-01T00:00:00Z'), status: 'draft' }, now)).toBe(true);
    expect(isOverdue({ scheduledDate: '2026-08-01T00:00:00Z', status: 'scheduled' }, now)).toBe(true);
  });

  it('is false once posted, archived, unscheduled, or still in the future', () => {
    expect(isOverdue({ scheduledDate: new Date('2026-08-01T00:00:00Z'), status: 'posted' }, now)).toBe(false);
    expect(isOverdue({ scheduledDate: new Date('2026-08-01T00:00:00Z'), status: 'archived' }, now)).toBe(false);
    expect(isOverdue({ scheduledDate: null, status: 'draft' }, now)).toBe(false);
    expect(isOverdue({ scheduledDate: new Date('2099-01-01T00:00:00Z'), status: 'draft' }, now)).toBe(false);
    expect(isOverdue({ scheduledDate: new Date('2026-08-01T00:00:00Z'), isTemplate: true }, now)).toBe(false);
  });
});
