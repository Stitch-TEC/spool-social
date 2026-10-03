import { describe, expect, it } from 'vitest';
import { findHelpGuide, guidesForAudience, HELP_GUIDES, HELP_SEARCH_LIMIT, searchHelpGuides } from './helpContent';

describe('static task guides', () => {
  it('has unique known topics, short useful steps and no executable markup', () => {
    expect(new Set(HELP_GUIDES.map(guide => guide.id)).size).toBe(HELP_GUIDES.length);
    for (const guide of HELP_GUIDES) {
      expect(guide.id).toMatch(/^[a-z-]+$/);
      expect(guide.steps.length).toBeGreaterThanOrEqual(3);
      expect(guide.steps.length).toBeLessThanOrEqual(5);
      expect(guide.title.length).toBeLessThan(55);
      expect(JSON.stringify(guide)).not.toMatch(/<script|javascript:|password=/i);
    }
  });
  it('separates operator, signed-in member and review-link instructions', () => {
    expect(findHelpGuide('send-review', 'operator')).not.toBeNull();
    expect(findHelpGuide('send-review', 'member')).toBeNull();
    expect(findHelpGuide('send-review', 'guest')).toBeNull();
    expect(findHelpGuide('create-member', 'member')).not.toBeNull();
    expect(findHelpGuide('create-member', 'operator')).toBeNull();
    expect(findHelpGuide('guest-review', 'member')).toBeNull();
    expect(findHelpGuide('guest-review', 'guest')).not.toBeNull();
    expect(guidesForAudience('guest').some(guide => guide.id === 'create-operator')).toBe(false);
  });
  it.each([undefined, null, 'admin', true, {}, ['operator']])('fails unknown audience %j to shared instructions', audience => {
    expect(guidesForAudience(audience).every(guide => guide.audiences.includes('unknown'))).toBe(true);
    expect(guidesForAudience(audience).map(guide => guide.id)).toEqual(['access']);
    expect(findHelpGuide('handoff', audience)).toBeNull();
  });
  it.each(['review', 'approval', 'video', 'save', 'recovery', 'access', 'navigation', 'import', 'CSV', 'spreadsheet', 'columns'])('finds useful results for %s', query => {
    expect(searchHelpGuides(query, 'operator').length).toBeGreaterThan(0);
  });
  it('searches all words without escaping the audience or interpreting input', () => {
    expect(searchHelpGuides('  VIDEO   drive ', 'operator').map(guide => guide.id)).toEqual(['video-links']);
    expect(searchHelpGuides('create private', 'guest')).toEqual([]);
    expect(searchHelpGuides('<img src=x onerror=alert(1)>', 'operator')).toEqual([]);
    expect(searchHelpGuides('z'.repeat(HELP_SEARCH_LIMIT) + ' review', 'operator')).toEqual([]);
    expect(searchHelpGuides(null, 'guest')).toEqual(guidesForAudience('guest'));
    expect(findHelpGuide('__proto__', 'operator')).toBeNull();
  });
  it('preserves the important product distinctions and actual action labels', () => {
    expect(findHelpGuide('send-review', 'operator').warning).toContain('does not send an email');
    expect(findHelpGuide('create-member', 'member').steps.join(' ')).toContain('review link supplied by your team');
    expect(findHelpGuide('create-member', 'member').warning).toContain('available for client review');
    expect(findHelpGuide('workflow', 'operator').steps.join(' ')).toContain('not proof of client approval');
    expect(findHelpGuide('handoff', 'operator').steps.join(' ')).toContain('stages a POM ticket');
    expect(findHelpGuide('video-links', 'member').warning).toContain('not a private attachment');
    expect(findHelpGuide('save-recovery', 'member').warning).toContain('Do not create another copy or clear browser storage');
    expect(findHelpGuide('access', 'guest').note).toContain('does not grant access');
  });
  it('explains the observed-only Usual badge in each writer’s existing guide, not guest instructions', () => {
    for (const [id, audience] of [['create-operator', 'operator'], ['create-member', 'member']]) {
      expect(findHelpGuide(id, audience).note).toBe('Usual marks the most-used platform in this client’s loaded threads; choose any platform you need.');
      expect(searchHelpGuides('usual platform', audience).map(guide => guide.id)).toContain(id);
    }
    expect(searchHelpGuides('usual', 'guest')).toEqual([]);
  });
  it('keeps import consequences role-selected and excludes review-link guests', () => {
    expect(findHelpGuide('import-operator', 'member')).toBeNull();
    expect(findHelpGuide('import-member', 'operator')).toBeNull();
    expect(searchHelpGuides('import', 'guest')).toEqual([]);
    expect(findHelpGuide('import-operator', 'operator').steps.join(' ')).toContain('private drafts');
    expect(findHelpGuide('import-member', 'member').warning).toContain('available for client review immediately');
    expect(findHelpGuide('import-fields', 'member').note).toContain('not a backup-restore path');
    expect(findHelpGuide('import-fields', 'operator').steps.join(' ')).toContain('never shortened');
    expect(findHelpGuide('import-operator', 'operator').warning).toContain('currently loaded threads');
  });
});
