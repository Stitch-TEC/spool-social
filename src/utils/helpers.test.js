import { describe, it, expect } from 'vitest';
import { resolveImage, TRANSFORMATIONS } from './helpers';

describe('resolveImage', () => {
  it('returns null for empty input', () => {
    expect(resolveImage(null, {})).toBeNull();
    expect(resolveImage('', {})).toBeNull();
  });

  it('passes inline data URLs straight through', () => {
    const data = 'data:image/png;base64,AAAA';
    expect(resolveImage(data, {})).toBe(data);
  });

  it('looks references up in the media map, or returns null when absent', () => {
    expect(resolveImage('ref1', { ref1: 'https://cdn/x.jpg' })).toBe('https://cdn/x.jpg');
    expect(resolveImage('missing', {})).toBeNull();
  });
});

describe('TRANSFORMATIONS', () => {
  it('punchy strips filler phrases, appends the suffix, and is idempotent', () => {
    const out = TRANSFORMATIONS.punchy('I think we should launch');
    expect(out).not.toMatch(/I think/);
    expect(out).toContain('#Growth #Building');
    expect(TRANSFORMATIONS.punchy(out)).toBe(out);
  });

  it('professional adds a prefix and is idempotent', () => {
    const out = TRANSFORMATIONS.professional('Big news');
    expect(out.startsWith('💡 Professional Update')).toBe(true);
    expect(TRANSFORMATIONS.professional(out)).toBe(out);
  });

  it('emojify appends emojis without duplicating them', () => {
    const once = TRANSFORMATIONS.emojify('We launch today');
    expect(once).toBe('We launch 🚀 today');
    expect(TRANSFORMATIONS.emojify(once)).toBe(once);
  });
});
