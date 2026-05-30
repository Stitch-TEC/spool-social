import { describe, it, expect } from 'vitest';
import { convertToCSV, parseCSV } from './csv';

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
});

describe('convertToCSV', () => {
  it('emits the expected header row', () => {
    const csv = convertToCSV([{ client: 'A', platform: 'gmb', content: 'hi' }]);
    const header = csv.split('\n')[0];
    expect(header).toBe('id,client,platform,content,status,approvalStatus,scheduledDate,createdAt,feedback,imageUrl');
  });

  it('quotes fields that contain a separator', () => {
    const csv = convertToCSV([{ client: 'A,B', platform: 'gmb', content: 'hi' }]);
    expect(csv).toContain('"A,B"');
  });

  it('escapes embedded double quotes by doubling them', () => {
    const csv = convertToCSV([{ client: 'X', platform: 'gmb', content: 'say "hi"' }]);
    expect(csv).toContain('"say ""hi"""');
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
});
