import { describe, expect, it } from 'vitest';
import { readRecovery, recoveryScope } from './editorRecovery';

describe('recovery identity envelope', () => {
  it('separates principals, clients, new flows and document IDs without delimiter collisions', () => {
    const scopes = [
      { principalId: 'a', clientId: 'alpha' }, { principalId: 'b', clientId: 'alpha' },
      { principalId: 'a', clientId: 'beta' }, { principalId: 'a', clientId: 'alpha', isTemplate: true },
      { principalId: 'a', clientId: 'alpha', postId: 'new' },
      { principalId: 'a:alpha', clientId: 'alpha', postId: 'doc/1' },
    ].map(recoveryScope);
    expect(new Set(scopes.map(s => s.key)).size).toBe(scopes.length);
  });
  it.each([{ principalId: '', clientId: 'alpha' }, { principalId: 'a', clientId: '' }, { principalId: 'a', clientId: 'Not a slug' }])('refuses unknown/invalid identity %j', input => {
    expect(recoveryScope(input)).toBeNull();
  });
  it('checks embedded ownership rather than trusting a moved storage key', () => {
    const scope = recoveryScope({ principalId: 'b', clientId: 'beta' });
    const foreign = recoveryScope({ principalId: 'a', clientId: 'alpha' });
    expect(readRecovery({ getItem: () => JSON.stringify({ scope: foreign, work: { content: 'Secret' } }) }, scope)).toBeNull();
  });
  it.each([{ content: 'Draft', tags: {} }, { content: 'Draft', isTemplate: 'yes' }, { content: ['invalid'] }, { content: 'Draft', imageUrl: {} }])('rejects malformed work %j', work => {
    const scope = recoveryScope({ principalId: 'a', clientId: 'alpha' });
    expect(readRecovery({ getItem: () => JSON.stringify({ scope, work }) }, scope)).toBeNull();
  });
});
