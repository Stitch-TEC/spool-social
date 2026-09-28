import { describe, expect, it } from 'vitest';
import { CLIENT_HANDOFF_LIMITS, inspectHandoffContent, parseClientHandoff, resolveClientHandoff } from './clientHandoff';

const scopeKey = 'project:operator:1';
const row = { slug: 'example-client', name: 'Example Studio', status: 'active' };
const intent = parseClientHandoff('?clientSlug=example-client');
const roster = (overrides = {}) => ({ clients: [row], loading: false, error: null,
  confirmed: true, scopeKey, readVersion: 'read:1', ...overrides });
const resolve = value => resolveClientHandoff(intent, value, scopeKey);

describe('strict, bounded client handoff query', () => {
  it.each(['', '?client=Legacy%20Name', '?uid=owner&client=Legacy', '?s=share-token',
    '?CLIENTSLUG=example-client', '?clientSlugExtra=example-client', '?x=%broken', null, undefined])('preserves absent/legacy input %s', search => {
    expect(parseClientHandoff(search)).toEqual({ status: 'absent' });
  });
  it.each(['?clientSlug=example-client', 'clientSlug=example-client', '?%63lientSlug=example-client',
    '?clientSlug=%65xample-client'])('accepts one canonical query %s', search => {
    expect(parseClientHandoff(search)).toEqual({ status: 'requested', slug: 'example-client' });
  });
  it.each(['', 'Example-client', ' example-client', 'example-client ', 'example_client', '-example',
    'example-', 'example--client', 'example/client', '..', '例', '%', '%E0%A4%A', 'a'.repeat(129),
    'example+client', 'example%00client'])('refuses malformed or noncanonical slug %s', slug => {
    expect(parseClientHandoff(`?clientSlug=${slug}`)).toEqual({ status: 'blocked', code: 'invalid_link' });
  });
  it.each(['?clientSlug', '?clientSlug=x&clientSlug=x', '?clientSlug=x&%63lientSlug=y',
    '?clientSlug=x&redirect=https://elsewhere.test', '?clientSlug=x&', '?clientSlug=x&&a=b',
    '?clientSlug=x&bad%ZZ=y', '?clientSlug=x#fragment'])('refuses duplicate/extra/malformed query %s', search => {
    expect(parseClientHandoff(search)).toEqual({ status: 'blocked', code: 'invalid_link' });
  });
  it.each(['client'])('refuses mixed %s links even when empty', key => {
    expect(parseClientHandoff(`?clientSlug=example-client&${key}=`)).toEqual({ status: 'blocked', code: 'mixed_link' });
  });
  it.each(['uid', 's'])('leaves the existing %s guest contract in charge', key => {
    expect(parseClientHandoff(`?clientSlug=example-client&${key}=`)).toEqual({ status: 'absent' });
  });
  it('bounds active query length and parameter count without changing unrelated oversized legacy URLs', () => {
    expect(parseClientHandoff(`?clientSlug=x&extra=${'a'.repeat(4096)}`).code).toBe('invalid_link');
    expect(parseClientHandoff(`?${'a&'.repeat(10000)}`)).toEqual({ status: 'absent' });
    expect(parseClientHandoff(`?${'a&'.repeat(10000)}clientSlug=x`).code).toBe('invalid_link');
    expect(parseClientHandoff(`?clientSlug=x&${'x=y&'.repeat(16)}`).code).toBe('invalid_link');
  });
  it('does not normalize or truncate the longest valid slug', () => {
    const slug = 'a'.repeat(CLIENT_HANDOFF_LIMITS.slug);
    expect(parseClientHandoff(`?clientSlug=${slug}`)).toEqual({ status: 'requested', slug });
  });
});

describe('legacy content identity compatibility', () => {
  const check = change => inspectHandoffContent({ clientName: row.name, slug: row.slug,
    posts: [], clientMap: {}, loading: false, error: null, ...change });
  it('accepts empty current content and correctly stamped records', () => {
    expect(check({}).status).toBe('ready');
    expect(check({ posts: [{ client: row.name, clientId: row.slug }, { client: row.name, source: 'suggestion', forClientId: row.slug }],
      clientMap: { [row.name]: { clientId: row.slug } } }).status).toBe('ready');
  });
  it('retains the explicit legacy unstamped boundary', () => {
    expect(check({ posts: [{ client: row.name }], clientMap: { [row.name]: {} } }).status).toBe('ready');
  });
  it.each(['Example Studio', 'EXAMPLE STUDIO', ' Example  Studio '])('detects conflicting ID for equivalent label %s', client => {
    expect(check({ posts: [{ client, clientId: 'other-client' }] }).code).toBe('content_conflict');
  });
  it('checks both canonical and suggestion stamps', () => {
    expect(check({ posts: [{ client: row.name, clientId: row.slug, source: 'suggestion', forClientId: 'other' }] }).code).toBe('content_conflict');
    expect(check({ posts: [{ client: row.name, clientId: 'other', source: 'suggestion', forClientId: row.slug }] }).code).toBe('content_conflict');
  });
  it('checks normalized branding keys and refuses malformed selected branding', () => {
    expect(check({ clientMap: { 'EXAMPLE  STUDIO': { clientId: 'other' } } }).code).toBe('content_conflict');
    expect(check({ clientMap: { [row.name]: null } }).code).toBe('content_conflict');
  });
  it('ignores other client names without claiming whole-inventory certification', () => {
    expect(check({ posts: [{ client: 'Other Name', clientId: 'other' }], clientMap: { Elsewhere: { clientId: 'other' } } }).status).toBe('ready');
  });
  it.each(['A/B', 'a'.repeat(51), ' Space '])('refuses names changed by existing editor sanitizer %s', clientName => {
    expect(check({ clientName }).status).toBe('blocked');
  });
  it('waits for loading and refuses failed or absent evidence', () => {
    expect(check({ loading: true })).toEqual({ status: 'pending', code: 'content_loading' });
    expect(check({ error: Error('private message') }).code).toBe('content_unavailable');
    expect(check({ posts: null }).code).toBe('content_unavailable');
    expect(check({ clientMap: null }).code).toBe('content_unavailable');
    expect(inspectHandoffContent().code).toBe('content_unavailable');
  });
});

describe('canonical current-roster handoff resolver', () => {
  it('uses the exact current label, never slugifies the name', () => {
    expect(resolve(roster())).toEqual({ status: 'resolved', slug: row.slug, name: row.name, readVersion: 'read:1' });
    expect(resolve(roster({ clients: [{ ...row, name: 'Renamed Studio' }] })).name).toBe('Renamed Studio');
  });
  it.each(['active', 'project', 'nonprofit', 'prospect', 'internal'])('accepts known non-archived status %s', status => {
    expect(resolve(roster({ clients: [{ ...row, status }] })).status).toBe('resolved');
  });
  it('rejects the archived target', () => {
    expect(resolve(roster({ clients: [{ ...row, status: 'archived' }] })).code).toBe('client_archived');
  });
  it('keeps pending separate from a confirmed missing target', () => {
    expect(resolve(roster({ loading: true }))).toEqual({ status: 'pending', code: 'roster_loading' });
    expect(resolve(roster({ clients: [] }))).toEqual({ status: 'blocked', code: 'client_unavailable' });
  });
  it.each([{ error: 'private provider message' }, { confirmed: false }, { confirmed: undefined },
    { scopeKey: 'old-session' }, { readVersion: null }, { readVersion: {} }, { readVersion: '' }])('refuses unconfirmed/stale reads %j', change => {
    expect(resolve(roster(change))).toEqual({ status: 'blocked', code: 'roster_unavailable' });
  });
  it.each([null, undefined, {}, { loading: false }])('requires an actual confirmed roster %j', value => {
    expect(resolve(value).status).toBe('blocked');
  });
  it('refuses duplicate slug even if rows are identical', () => {
    expect(resolve(roster({ clients: [row, { ...row }] })).code).toBe('client_ambiguous');
  });
  it.each(['Example Studio', 'EXAMPLE STUDIO', 'Example  Studio'])('refuses colliding display name %s across slugs', name => {
    expect(resolve(roster({ clients: [row, { slug: 'different', name, status: 'active' }] })).code).toBe('client_ambiguous');
  });
  it('includes archived duplicate labels in ambiguity detection', () => {
    expect(resolve(roster({ clients: [row, { slug: 'old', name: row.name, status: 'archived' }] })).code).toBe('client_ambiguous');
  });
  it.each([null, [], {}, { ...row, slug: 'Wrong' }, { ...row, name: '' }, { ...row, name: ' Space ' },
    { ...row, name: 'a'.repeat(201) }, { ...row, name: 'Bad\nName' }, { ...row, status: '' },
    { ...row, status: 'unknown' }, { ...row, status: null }])('rejects malformed rows without silently dropping them %j', invalid => {
    expect(resolve(roster({ clients: [row, invalid] })).code).toBe('roster_invalid');
  });
  it('bounds roster size and requires an array', () => {
    expect(resolve(roster({ clients: {} })).code).toBe('roster_invalid');
    expect(resolve(roster({ clients: Array(1001).fill(row) })).code).toBe('roster_invalid');
  });
  it('does not trust a forged requested intent or a missing expected scope', () => {
    expect(resolveClientHandoff({ status: 'requested', slug: '../bad' }, roster(), scopeKey).code).toBe('invalid_link');
    expect(resolveClientHandoff(intent, roster(), '').code).toBe('roster_unavailable');
    expect(resolveClientHandoff({ status: 'absent' }, roster(), scopeKey)).toEqual({ status: 'absent' });
  });
});
