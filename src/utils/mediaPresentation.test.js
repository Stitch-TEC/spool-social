import { describe, expect, it } from 'vitest';
import { readableMediaItems, videoMediaPresentation, mediaMatchesSearch, confirmedLibraryItem } from './mediaPresentation';

const video = url => ({ key: 'library/o/omni/clip', type: 'video', url });
describe('media presentation without external metadata requests', () => {
  it.each([
    ['https://www.youtube.com/watch?v=P01_Short001', 'YouTube · P01_Short001'],
    ['https://youtu.be/P02_Short002?t=42', 'YouTube · P02_Short002'],
    ['https://youtube.com/shorts/P03_Short003', 'YouTube · P03_Short003'],
    ['https://vimeo.com/123456789', 'Vimeo · 123456789'],
    ['https://player.vimeo.com/video/123456789?h=signed', 'Vimeo · 123456789'],
    ['https://cdn.example.com/folder/CT%20demo-v02.mp4?token=secret', 'Video file · CT demo-v02.mp4'],
  ])('identifies %s without fetching', (url, label) => {
    expect(videoMediaPresentation(video(url))).toMatchObject({ url, label });
  });
  it('uses safe existing metadata without modifying the saved item', () => {
    const item = { ...video('https://youtu.be/abcdefghijk'), title: 'CT demo v2' };
    expect(videoMediaPresentation(item)).toMatchObject({ label: 'CT demo v2', detail: 'abcdefghijk' });
    expect(item.title).toBe('CT demo v2');
  });
  it('does not label an unsafe or unsupported video as selectable', () => {
    for (const url of ['javascript:alert(1)', 'http://youtu.be/abcdefghijk', 'https://youtube.com.evil.example/watch?v=id', 'https://127.0.0.1/video.mp4', 'https://user:pass@youtube.com/watch?v=id']) {
      expect(videoMediaPresentation(video(url))).toBeNull();
    }
  });
  it('does not expose a query string as its fallback title or search text', () => {
    const item = video('https://cdn.example.com/video.mp4?token=private-token');
    expect(videoMediaPresentation(item).label).toBe('Video file · video.mp4');
    expect(mediaMatchesSearch(item, 'private-token')).toBe(false);
  });
  it('searches saved labels, provider, video identifier and image filename', () => {
    expect(mediaMatchesSearch({ ...video('https://youtu.be/abcdefghijk'), label: 'CT scan v1' }, 'ct scan')).toBe(true);
    expect(mediaMatchesSearch(video('https://youtu.be/abcdefghijk'), 'ABCDEFG')).toBe(true);
    expect(mediaMatchesSearch(video('https://vimeo.com/12345'), 'vimeo')).toBe(true);
    expect(mediaMatchesSearch({ key: 'library/o/omni/team.jpg', type: 'image', url: '/media/team.jpg' }, 'TEAM')).toBe(true);
  });
  it('searches all saved aliases even when the display title takes precedence', () => {
    const item = { ...video('https://youtu.be/abcdefghijk'), title: 'Display title', label: 'P01 inspection', name: 'Final CT cut' };
    expect(mediaMatchesSearch(item, 'inspection')).toBe(true);
    expect(mediaMatchesSearch(item, 'final ct')).toBe(true);
  });
  it('refuses a missing, stale or malformed title acknowledgement', () => {
    const item = video('https://youtu.be/abcdefghijk');
    for (const title of [undefined, 'Different', null, 'P01\n']) {
      expect(() => confirmedLibraryItem({ ...item, ...(title !== undefined ? { title } : {}) }, 'video', 'omni', item.url, 'P01')).toThrow('Unconfirmed video title');
    }
    expect(confirmedLibraryItem({ ...item, title: 'P01' }, 'video', 'omni', item.url, 'P01').title).toBe('P01');
    expect(confirmedLibraryItem(item, 'video', 'omni', item.url, '')).toBe(item);
  });
  it('preserves a valid list and rejects malformed or duplicate item identities', () => {
    const list = [video('https://youtu.be/abcdefghijk')];
    expect(readableMediaItems(list)).toBe(list);
    for (const value of [null, {}, [null], [{ ...list[0], type: 'other' }], [{ ...list[0], key: '' }], [list[0], list[0]]]) {
      expect(() => readableMediaItems(value)).toThrow();
    }
  });
  it('rejects over-bound metadata and lists rather than silently truncating saved rows', () => {
    expect(() => readableMediaItems(Array.from({ length: 10001 }, (_, index) => ({ ...video('https://youtu.be/id'), key: `${index}` })))).toThrow();
    expect(() => readableMediaItems([{ ...video('https://youtu.be/id'), url: 'x'.repeat(4097) }])).toThrow();
    expect(videoMediaPresentation({ ...video('https://youtu.be/id'), title: 'x'.repeat(241) }).label).toBe('YouTube · id');
  });
  it('requires a current-client exact video or hosted-image acknowledgement', () => {
    const item = video('https://youtu.be/abcdefghijk');
    expect(confirmedLibraryItem(item, 'video', 'omni', item.url)).toBe(item);
    const image = { key: 'library/o/omni/cover.jpg', type: 'image', url: 'https://spool.stitchtec.dev/media/v2/library/o/omni/cover.jpg' };
    expect(confirmedLibraryItem(image, 'image', 'omni')).toBe(image);
    for (const malformed of [{ ...image, url: 'https://evil.example/media/library/o/omni/cover.jpg' }, { ...image, url: '/media/other.jpg' }, { ...image, type: 'video' }]) {
      expect(() => confirmedLibraryItem(malformed, 'image', 'omni')).toThrow();
    }
  });
});
