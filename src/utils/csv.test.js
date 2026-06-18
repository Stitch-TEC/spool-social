import { describe, it, expect } from 'vitest';
import { convertToCSV, parseCSV, parseJSON, parseImportFile, postsToJSON, postFingerprint, CSV_COLUMNS } from './csv';

describe('csv round-trip', () => {
  it('preserves content containing commas, quotes and newlines', () => {
    const posts = [{
      id: '1',
      client: 'Acme',
      platform: 'twitter',
      content: 'Hello, world\n"quoted"',
      status: 'draft',
      approvalStatus: 'pending',
      scheduledDate: new Date('2025-06-01T10:00:00.000Z'),
      createdAt: new Date('2025-05-01T10:00:00.000Z'),
      feedback: '',
      imageUrl: '',
    }];
    const parsed = parseCSV(convertToCSV(posts));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].content).toBe('Hello, world\n"quoted"');
    expect(parsed[0].client).toBe('Acme');
    expect(parsed[0].platform).toBe('twitter');
    expect(parsed[0].scheduledDate).toBe('2025-06-01T10:00:00.000Z');
  });

  it('round-trips long-form fields and tags (lossless)', () => {
    const posts = [{
      client: 'Acme',
      platform: 'blog',
      title: 'My Title',
      content: '# Heading\n\nBody',
      altText: 'a cat',
      metaDescription: 'meta here',
      slug: 'my-title',
      tags: ['alpha', 'beta', 'gamma'],
    }];
    const parsed = parseCSV(convertToCSV(posts));
    expect(parsed[0]).toMatchObject({
      title: 'My Title',
      altText: 'a cat',
      metaDescription: 'meta here',
      slug: 'my-title',
      platform: 'blog',
      tags: ['alpha', 'beta', 'gamma'],
    });
  });
});

describe('convertToCSV', () => {
  it('emits the expected lossless header row', () => {
    const csv = convertToCSV([{ client: 'A', platform: 'gmb', content: 'hi' }]);
    const header = csv.split('\n')[0];
    expect(header).toBe(CSV_COLUMNS.join(','));
    expect(header).toContain('title');
    expect(header).toContain('tags');
    expect(header).toContain('altText');
  });

  it('quotes fields that contain a separator', () => {
    const csv = convertToCSV([{ client: 'A,B', platform: 'gmb', content: 'hi' }]);
    expect(csv).toContain('"A,B"');
  });

  it('escapes embedded double quotes by doubling them', () => {
    const csv = convertToCSV([{ client: 'X', platform: 'gmb', content: 'say "hi"' }]);
    expect(csv).toContain('"say ""hi"""');
  });

  it('serializes tags joined by a pipe', () => {
    const csv = convertToCSV([{ client: 'X', platform: 'gmb', content: 'hi', tags: ['a', 'b'] }]);
    expect(csv).toContain('a|b');
  });
});

describe('parseCSV', () => {
  it('returns [] when there is no data row', () => {
    expect(parseCSV('id,client,content')).toEqual([]);
    expect(parseCSV('')).toEqual([]);
  });

  it('skips rows missing the required client or content', () => {
    const parsed = parseCSV('client,content\nAcme,\n,Body\nAcme,Body');
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ client: 'Acme', content: 'Body' });
  });

  it('falls back to safe defaults for invalid enum values', () => {
    const [post] = parseCSV('client,content,platform,status,approvalStatus\nAcme,Body,myspace,bogus,maybe');
    expect(post.platform).toBe('gmb');
    expect(post.status).toBe('draft');
    expect(post.approvalStatus).toBe('pending');
  });

  it('normalizes valid dates to ISO and nulls invalid ones', () => {
    const parsed = parseCSV('client,content,scheduledDate\nAcme,Body,2025-06-01T10:00:00.000Z\nAcme,Body2,not-a-date');
    expect(parsed[0].scheduledDate).toBe('2025-06-01T10:00:00.000Z');
    expect(parsed[1].scheduledDate).toBeNull();
  });

  it('parses a comma-separated tag cell too', () => {
    const [post] = parseCSV('client,content,tags\nAcme,Body,"one, two, three"');
    expect(post.tags).toEqual(['one', 'two', 'three']);
  });
});

describe('JSON transfer', () => {
  it('round-trips through postsToJSON / parseJSON', () => {
    const posts = [{
      id: 'x', _searchContent: 'ignore', client: 'Acme', platform: 'linkedin',
      content: 'Body', tags: ['t1'], scheduledDate: new Date('2025-06-01T10:00:00.000Z'),
    }];
    const json = postsToJSON(posts);
    expect(json).not.toContain('_searchContent'); // internal cache fields stripped
    const parsed = parseJSON(json);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ client: 'Acme', platform: 'linkedin', tags: ['t1'] });
    expect(parsed[0].scheduledDate).toBe('2025-06-01T10:00:00.000Z');
  });

  it('accepts a bare array or a { posts } envelope', () => {
    expect(parseJSON('[{"client":"A","content":"B"}]')).toHaveLength(1);
    expect(parseJSON('{"posts":[{"client":"A","content":"B"}]}')).toHaveLength(1);
  });
});

describe('parseImportFile', () => {
  it('detects JSON by content', () => {
    expect(parseImportFile('[{"client":"A","content":"B"}]')).toHaveLength(1);
  });
  it('detects CSV by content', () => {
    expect(parseImportFile('client,content\nA,B')).toHaveLength(1);
  });
});

describe('postFingerprint', () => {
  it('matches on client+platform+content, case-insensitive client', () => {
    expect(postFingerprint({ client: 'Acme', platform: 'gmb', content: 'x' }))
      .toBe(postFingerprint({ client: 'acme', platform: 'gmb', content: 'x' }));
  });
});
