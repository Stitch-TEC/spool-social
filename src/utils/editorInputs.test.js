import { describe, expect, it } from 'vitest';
import { validatedTags, defaultPlatformForClient } from './editorInputs';

describe('editor input limits', () => {
  it('accepts exact limits without changing meaning', () => {
    const tags = Array.from({ length: 10 }, (_, i) => `${i}${'a'.repeat(19)}`);
    expect(validatedTags(tags)).toEqual(tags);
  });
  it.each([null, 'tag', [4], [''], ['a'.repeat(21)], Array(11).fill('tag'), ['tag', ' tag ']])('refuses invalid tags: %j', value => {
    expect(() => validatedTags(value)).toThrow();
  });
  it('defaults only from supported same-client observed posts', () => {
    expect(defaultPlatformForClient([
      { clientId: 'omni', platform: 'linkedin' }, { clientId: 'omni', platform: 'linkedin' },
      { clientId: 'other', platform: 'gmb' }, { clientId: 'omni', platform: 'unknown' },
      { clientId: 'omni', platform: 'gmb', isTemplate: true },
      { clientId: 'omni', platform: 'gmb', status: 'archived' },
    ], 'omni')).toBe('linkedin');
    expect(defaultPlatformForClient([{ platform: 'linkedin' }], '')).toBe('gmb');
    expect(defaultPlatformForClient(null, 'omni')).toBe('gmb');
  });
});
