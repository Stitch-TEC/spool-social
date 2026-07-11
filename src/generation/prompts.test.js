import { describe, it, expect } from 'vitest';
import { PLATFORM_META, PLATFORM_CADENCE, PLATFORM_IMAGE_ASPECT } from './prompts';
import { PLATFORMS } from '../constants';

// PLATFORM_META is the shared (Worker + app) source of truth for char limits.
// constants.js PLATFORMS sources its limits from it; these guards fail loudly
// if anyone re-hardcodes a mismatch or forgets a platform in one of the tables.
describe('platform table parity', () => {
  const ids = Object.keys(PLATFORMS);

  it('PLATFORM_META covers exactly the same platforms as PLATFORMS', () => {
    expect(Object.keys(PLATFORM_META).sort()).toEqual(ids.sort());
  });

  it('maxChars and longForm match between PLATFORMS and PLATFORM_META', () => {
    for (const id of ids) {
      expect(PLATFORMS[id].maxChars).toBe(PLATFORM_META[id].maxChars);
      expect(!!PLATFORMS[id].longForm).toBe(!!PLATFORM_META[id].longForm);
    }
  });

  it('every platform has a cadence and an image aspect', () => {
    for (const id of ids) {
      expect(PLATFORM_CADENCE[id]?.minHours).toBeGreaterThan(0);
      expect(PLATFORM_CADENCE[id]?.defaultHours).toBeGreaterThanOrEqual(PLATFORM_CADENCE[id].minHours);
      expect(typeof PLATFORM_IMAGE_ASPECT[id]).toBe('string');
    }
  });

  it('includes facebook as a first-class social platform with a rendered icon', () => {
    expect(PLATFORM_META.facebook).toBeDefined();
    expect(PLATFORM_META.facebook.longForm).toBe(false);
    expect(PLATFORMS.facebook?.name).toBe('Facebook');
    expect(PLATFORMS.facebook?.icon).toBeTruthy(); // lucide Facebook component wired in
  });
});
