import { describe, expect, it } from 'vitest';
import { confirmedUsualClientId, usualPlatformForClient } from './usualPlatform';
import { defaultPlatformForClient } from './editorInputs';

describe('confirmed usual client display scope', () => {
  const clients = [{ name: 'OMNI NDE', slug: 'omni-nde' }, { name: 'Other', slug: 'other' }];
  it('matches only the complete canonical name, with normal case/spacing drift', () => {
    expect(confirmedUsualClientId('  omni   NDE ', clients)).toBe('omni-nde');
    expect(confirmedUsualClientId('OMNI', clients)).toBeNull();
    expect(confirmedUsualClientId('Unknown', clients)).toBeNull();
    expect(confirmedUsualClientId('omni-nde', clients)).toBeNull();
  });
  it.each([null, undefined, '', 4, {}, []])('does not guess a tenant from %j', value => {
    expect(confirmedUsualClientId(value, clients)).toBeNull();
  });
  it.each([null, undefined, {}, []])('refuses an unavailable/empty roster %j', roster => {
    expect(confirmedUsualClientId('OMNI NDE', roster)).toBeNull();
  });
  it('refuses two canonical tenants with the same normalized name', () => {
    expect(confirmedUsualClientId('OMNI NDE', [...clients, { name: 'omni  nde', slug: 'another' }])).toBeNull();
    expect(confirmedUsualClientId('OMNI NDE', [...clients, clients[0]])).toBe('omni-nde');
  });
  it.each(['', null, 4, 'bad/id', 'upperCase', 'x'.repeat(65)])('refuses malformed matching canonical IDs %j', slug => {
    expect(confirmedUsualClientId('OMNI NDE', [{ name: 'OMNI NDE', slug }])).toBeNull();
  });
});

describe('usual platform from loaded same-client content only', () => {
  it('counts only supported non-template/non-archived/non-suggestion posts from the exact tenant', () => {
    const posts = [
      { clientId: 'omni-nde', platform: 'linkedin' }, { clientId: 'omni-nde', platform: 'linkedin' },
      ...Array.from({ length: 3 }, () => ({ clientId: 'other', platform: 'gmb' })),
      { client: 'OMNI NDE', platform: 'gmb' }, { clientId: 'omni-nde', platform: '__proto__' },
      { clientId: 'omni-nde', platform: 'gmb', isTemplate: true },
      { clientId: 'omni-nde', platform: 'gmb', status: 'archived' },
      { clientId: 'omni-nde', platform: 'gmb', source: 'suggestion' },
    ];
    const before = structuredClone(posts);
    expect(usualPlatformForClient(posts, 'omni-nde')).toBe('linkedin');
    expect(posts).toEqual(before);
  });
  it.each([null, undefined, {}, []])('does not label the fallback as observed for %j', posts => {
    expect(usualPlatformForClient(posts, 'omni-nde')).toBeNull();
    expect(defaultPlatformForClient(posts, 'omni-nde')).toBe('gmb');
  });
  it('suppresses a foreign-only or unsupported-only history instead of inventing evidence', () => {
    expect(usualPlatformForClient([{ clientId: 'other', platform: 'gmb' }], 'omni-nde')).toBeNull();
    expect(usualPlatformForClient([{ clientId: 'omni-nde', platform: 'unknown' }], 'omni-nde')).toBeNull();
  });
  it.each([null, '', 'bad/id', 4, {}])('refuses invalid tenant %j', clientId => {
    expect(usualPlatformForClient([{ clientId: 'omni-nde', platform: 'linkedin' }], clientId)).toBeNull();
  });
  it('retains the existing stable platform-order tie rule without modifying the default helper', () => {
    const posts = [{ clientId: 'omni-nde', platform: 'linkedin' }, { clientId: 'omni-nde', platform: 'facebook' }];
    expect(usualPlatformForClient(posts, 'omni-nde')).toBe('facebook');
    expect(defaultPlatformForClient(posts, 'omni-nde')).toBe('facebook');
  });
  it('can genuinely observe Google Business without claiming an empty-history default', () => {
    expect(usualPlatformForClient([{ clientId: 'omni-nde', platform: 'gmb' }], 'omni-nde')).toBe('gmb');
  });
});
