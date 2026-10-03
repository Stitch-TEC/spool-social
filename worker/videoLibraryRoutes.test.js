import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), getUserRecord: vi.fn(), checkRateLimit: vi.fn() }));
vi.mock('./auth.js', async original => ({ ...await original(), authenticate: mocks.authenticate }));
vi.mock('./firestore.js', async original => ({ ...await original(), getUserRecord: mocks.getUserRecord }));
vi.mock('./ratelimit.js', () => ({ checkRateLimit: mocks.checkRateLimit }));
import worker from './index.js';

let env;
const url = 'https://youtu.be/abcdefghijk?t=42';
const request = (method = 'POST', body = { client: 'acme', videoUrl: url }) => worker.fetch(new Request(
  `https://spool.stitchtec.dev/api/media${method === 'GET' ? '?client=acme' : ''}`, {
    method, ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  }), env, {});

beforeEach(() => {
  vi.clearAllMocks();
  env = { OWNER_UID: 'operator', PUBLIC_ORIGIN: 'https://spool.stitchtec.dev', ALLOWED_ORIGINS: '*',
    MEDIA: { list: vi.fn().mockResolvedValue({ objects: [], truncated: false }), put: vi.fn().mockResolvedValue({}), delete: vi.fn() } };
  mocks.authenticate.mockResolvedValue({ mode: 'apikey', principal: 'internal' });
  mocks.checkRateLimit.mockResolvedValue({ ok: true });
  mocks.getUserRecord.mockResolvedValue({ roles: ['client'], clientId: 'acme' });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected external fetch')));
});
afterEach(() => vi.unstubAllGlobals());

describe('video library route uses optional safe metadata without external lookup', () => {
  it('stores a title only on the new pointer and returns exact acknowledgement', async () => {
    const response = await request('POST', { client: 'acme', videoUrl: url, videoTitle: '  P01 CT demo v2  ' });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({ type: 'video', url, provider: 'youtube', title: 'P01 CT demo v2' });
    expect(body.key).toMatch(/^library\/operator\/acme\/v-/);
    expect(env.MEDIA.put).toHaveBeenCalledExactlyOnceWith(body.key, 'video', { customMetadata: {
      type: 'video', url, provider: 'youtube', title: 'P01 CT demo v2', addedAt: expect.any(String),
    } });
    expect(env.MEDIA.delete).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it.each([undefined, '', '   '])('preserves old omitted/blank title contract: %j', async videoTitle => {
    const response = await request('POST', { client: 'acme', videoUrl: url, ...(videoTitle !== undefined ? { videoTitle } : {}) });
    expect(response.status).toBe(201);
    expect(await response.json()).not.toHaveProperty('title');
    expect(env.MEDIA.put.mock.calls[0][2].customMetadata).not.toHaveProperty('title');
  });
  it.each([null, false, {}, 'x'.repeat(121), 'one\ntwo', 'one\u0000two', 'one\u202etwo', 'one\u2028two', 'one\u2029two'])(
    'refuses malformed title before storing: %j', async videoTitle => {
      expect((await request('POST', { client: 'acme', videoUrl: url, videoTitle })).status).toBe(400);
      expect(env.MEDIA.put).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    });
  it.each(['http://youtu.be/abcdefghijk', 'https://user:pass@youtu.be/abcdefghijk', 'https://youtu.be:8443/abcdefghijk',
    'https://127.0.0.1/clip.mp4', 'https://host.local/clip.mp4', 'https://[::1]/clip.mp4', 'https://youtube.com.evil.example/watch?v=id',
    'https://example.com/video.mp4\n', 'https://example.com/%00video.mp4', 1, {}, 'https://drive.google.com/file/d/id'])(
    'refuses unsafe or unsupported new URL %j', async videoUrl => {
      expect((await request('POST', { client: 'acme', videoUrl })).status).toBe(400);
      expect(env.MEDIA.put).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    });
  it.each(['https://youtube.com/shorts/abcdefghijk', 'https://player.vimeo.com/video/12345?h=synthetic',
    'https://cdn.example.com/CT%20demo.mp4?token=synthetic', 'https://cdn.example.com/demo.webm'])(
    'retains full admitted new URL %s', async videoUrl => {
      const response = await request('POST', { client: 'acme', videoUrl });
      expect(response.status).toBe(201); expect((await response.json()).url).toBe(videoUrl);
    });
  it('returns valid saved title but leaves legacy objects unchanged', async () => {
    const objects = [
      { key: 'library/operator/acme/new', customMetadata: { type: 'video', url, provider: 'youtube', title: 'P01' } },
      { key: 'library/operator/acme/old', customMetadata: { type: 'video', url, provider: 'youtube' } },
      { key: 'library/operator/acme/bad', customMetadata: { type: 'video', url: 'http://youtu.be/old', provider: 'youtube', title: 'bad\u202etitle' } },
    ];
    const original = JSON.stringify(objects);
    env.MEDIA.list.mockResolvedValue({ objects, truncated: false });
    const response = await request('GET'); expect(response.status).toBe(200);
    const { media } = await response.json();
    expect(media[0]).toMatchObject({ title: 'P01', url });
    expect(media[1]).not.toHaveProperty('title'); expect(media[2]).not.toHaveProperty('title');
    expect(media[2].url).toBe('http://youtu.be/old'); expect(JSON.stringify(objects)).toBe(original);
    expect(env.MEDIA.put).not.toHaveBeenCalled(); expect(env.MEDIA.delete).not.toHaveBeenCalled();
  });
  it.each(['anonymous', 'foreign', 'unprovisioned', 'rate', 'full'])('retains authorization/quota gate: %s', async kind => {
    if (kind === 'anonymous') mocks.authenticate.mockResolvedValue(null);
    if (kind === 'foreign') mocks.authenticate.mockResolvedValue({ mode: 'firebase', principal: 'member' });
    if (kind === 'unprovisioned') { mocks.authenticate.mockResolvedValue({ mode: 'firebase', principal: 'member' }); mocks.getUserRecord.mockResolvedValue(null); }
    if (kind === 'rate') mocks.checkRateLimit.mockResolvedValue({ ok: false, limit: 1, scope: 'minute', retryAfter: 20 });
    if (kind === 'full') env.MEDIA.list.mockResolvedValue({ objects: Array.from({ length: 50 }, (_, i) => ({ key: String(i) })), truncated: false });
    const response = await request('POST', { client: kind === 'foreign' ? 'other' : 'acme', videoUrl: url, videoTitle: 'P01' });
    expect(response.status).toBe({ anonymous: 401, foreign: 403, unprovisioned: 403, rate: 429, full: 409 }[kind]);
    expect(env.MEDIA.put).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
});
