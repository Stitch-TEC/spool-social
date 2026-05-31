import { describe, it, expect } from 'vitest';
import { resolveImage } from './helpers';

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
