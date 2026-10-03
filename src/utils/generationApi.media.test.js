import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const auth = vi.hoisted(() => ({ currentUser: null }));
vi.mock('../config/firebase', () => ({ auth }));
import { addVideoUrl, listMedia, listClientMedia } from './generationApi';
const videoUrl = 'https://youtu.be/abcdefghijk';
const pending = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

beforeEach(() => {
  auth.currentUser = { getIdToken: vi.fn().mockResolvedValue('synthetic-token') };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ key: 'synthetic' }), { status: 201 })));
});
afterEach(() => vi.unstubAllGlobals());

describe('video add API admission and additive metadata', () => {
  it('sends a trimmed title without shortening the source URL', async () => {
    const url = `${videoUrl}?t=42&token=synthetic`;
    await addVideoUrl('acme', url, { title: '  P01 cut v2  ', isCurrent: () => true });
    expect(fetch).toHaveBeenCalledOnce();
    const [path, options] = fetch.mock.calls[0];
    expect(path).toBe('/api/media');
    expect(JSON.parse(options.body)).toEqual({ client: 'acme', videoUrl: url, videoTitle: 'P01 cut v2' });
    expect(options.headers.Authorization).toBe('Bearer synthetic-token');
  });
  it.each([undefined, '', '   '])('omits blank title for old callers: %j', async title => {
    await addVideoUrl('acme', videoUrl, { title });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ client: 'acme', videoUrl });
  });
  it.each([null, false, 'x'.repeat(121), 'bad\ntitle', 'bad\u202etitle'])(
    'refuses invalid title before token or request: %j', async title => {
      await expect(addVideoUrl('acme', videoUrl, { title })).rejects.toThrow('Video title');
      expect(auth.currentUser.getIdToken).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    });
  it.each(['actor', 'scope', 'close', 'throw'])('refuses retirement during token wait: %s', async mode => {
    const token = pending();
    const captured = auth.currentUser;
    captured.getIdToken.mockReturnValue(token.promise);
    let current = true;
    const result = addVideoUrl('acme', videoUrl, { title: 'P01', isCurrent: () => {
      if (!current && mode === 'throw') throw new Error('Retired');
      return current;
    } });
    const refusal = expect(result).rejects.toThrow();
    if (mode === 'actor') auth.currentUser = { getIdToken: vi.fn() };
    else current = false;
    token.resolve('old-token');
    await refusal;
    expect(fetch).not.toHaveBeenCalled();
  });
  it('checks admission before requesting a token', async () => {
    await expect(addVideoUrl('acme', videoUrl, { isCurrent: () => false })).rejects.toThrow('No request was sent');
    expect(auth.currentUser.getIdToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not claim that retirement cancels an already submitted request', async () => {
    const reply = pending(); fetch.mockReturnValue(reply.promise);
    let current = true;
    const result = addVideoUrl('acme', videoUrl, { isCurrent: () => current });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    current = false;
    reply.resolve(new Response(JSON.stringify({ key: 'accepted' }), { status: 201 }));
    expect(await result).toEqual({ key: 'accepted' });
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe('media reads cannot turn malformed success into an empty library', () => {
  it.each([{}, { media: null }, { media: false }, { media: {} }, { media: [null] }])('refuses %j', async body => {
    fetch.mockImplementation(async () => new Response(JSON.stringify(body)));
    await expect(listMedia('acme')).rejects.toThrow('Invalid media response');
    await expect(listClientMedia('acme')).rejects.toThrow('Invalid media response');
  });
  it('accepts a genuinely empty list', async () => {
    fetch.mockImplementation(async () => new Response(JSON.stringify({ media: [] })));
    expect(await listMedia('acme')).toEqual([]);
    expect(await listClientMedia('acme')).toEqual([]);
  });
});
