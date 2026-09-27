import { describe, expect, it } from 'vitest';
import { extractVideoReferences, hasVideoReference, parseVideoReference, VIDEO_REFERENCE_LIMIT } from './videoReferences';

describe('parseVideoReference', () => {
  it.each([
    ['https://drive.google.com/file/d/abc/view?usp=sharing#details', 'Google Drive'],
    ['https://1drv.ms/v/s!abc?e=def', 'OneDrive'],
    ['https://onedrive.live.com/?cid=ABC&id=ABC%21123', 'OneDrive'],
    ['https://acme.sharepoint.com/:v:/s/Marketing/Abc?e=123', 'SharePoint'],
    ['https://acme-my.sharepoint.com/personal/person/video.mp4?web=1', 'SharePoint'],
    ['https://sharepoint.com/file', 'SharePoint'],
    ['https://youtube.com/watch?v=test&t=30', 'YouTube'],
    ['https://www.youtube.com/shorts/abc', 'YouTube'],
    ['https://m.youtube.com/watch?v=abc', 'YouTube'],
    ['https://youtu.be/abc?t=3', 'YouTube'],
    ['https://vimeo.com/12345/secret', 'Vimeo'],
    ['https://player.vimeo.com/video/12345?h=secret', 'Vimeo'],
    ['https://www.dropbox.com/scl/fi/abc/file.mov?rlkey=secret&dl=0', 'Dropbox'],
    ['https://dl.dropboxusercontent.com/s/file.mov', 'Dropbox'],
    ['https://cdn.example.com/path/clip.MP4?sig=a%2Fb%3D#t=20', 'Video file'],
    ['https://cdn.example.com/path/clip.webm', 'Video file'],
    ['https://cdn.example.com/path/clip.mov', 'Video file'],
    ['https://cdn.example.com/path/clip.m4v', 'Video file'],
  ])('accepts supported destination %s', (url, provider) => {
    expect(parseVideoReference(url)).toEqual({ url, provider, hostname: new URL(url).hostname });
  });

  it('normalizes only URL parsing, preserving meaningful queries and fragments', () => {
    const raw = 'HTTPS://DRIVE.GOOGLE.COM:443/file/d/id/view?usp=sharing&name=a%20b%2Bc#details';
    expect(parseVideoReference(raw)).toEqual({
      url: 'https://drive.google.com/file/d/id/view?usp=sharing&name=a%20b%2Bc#details',
      provider: 'Google Drive', hostname: 'drive.google.com',
    });
  });

  it.each([
    null, undefined, {}, 23, '', ' https://youtu.be/abc', 'https://youtu.be/abc ',
    'http://youtu.be/abc', '//youtu.be/abc', 'javascript:https://youtu.be/abc',
    'data:text/html,https://youtu.be/abc', 'file:///a.mp4', 'blob:https://youtu.be/abc',
    'https://name:secret@drive.google.com/file/d/id/view', 'https://drive.google.com@evil.example/a.mp4',
    'https://youtu.be:444/abc', 'https://drive.google.com./file/d/id/view',
    'https://drive.google.com.evil.example/file/d/id', 'https://evilsharepoint.com/file',
    'https://sharepoint.com.evil.example/file', 'https://youtube.com.evil.example/watch',
    'https://drive.google.com\\@evil.example/a.mp4', 'https://youtu.be/a\nb',
    'https://youtu.be/a\tb', 'https://youtu.be/a\u0000b', 'https://youtu.be/a b',
    'https://youtu.be/a\u0085b', 'https://youtu.be/a\u00a0b', 'https://youtu.be/a\u200bb',
    'https://youtu.be/a\u202eb', 'https://youtu.be/a\u2066b',
    'https://youtu.be/a"b', 'https://youtu.be/a<b', 'https://youtu.be/a>b', 'https://youtu.be/a`b',
    'https://youtu.be/a%0ab', 'https://youtu.be/a%5Cb', 'https://youtu.be/a%7fb',
    'https://localhost/clip.mp4', 'https://video.localhost/clip.mp4', 'https://video.local/clip.mp4',
    'https://video.internal/clip.mp4', 'https://video.intranet/clip.mp4', 'https://video.lan/clip.mp4',
    'https://video.home/clip.mp4', 'https://video.home.arpa/clip.mp4', 'https://video.test/clip.mp4',
    'https://video.invalid/clip.mp4', 'https://video.onion/clip.mp4', 'https://intranet/clip.mp4',
    'https://127.0.0.1/a.mp4', 'https://10.0.0.2/a.mp4', 'https://169.254.169.254/a.mp4',
    'https://8.8.8.8/a.mp4', 'https://2130706433/a.mp4', 'https://0x7f000001/a.mp4',
    'https://[::1]/a.mp4', 'https://[2606:4700:4700::1111]/a.mp4',
    'https://cdn.example.com/a.svg', 'https://cdn.example.com/a.mp4.exe',
    'https://cdn.example.com/download?file=a.mp4', 'https://cdn.example.com/a%2Emp4',
  ])('rejects unsupported/unsafe input %s', raw => expect(parseVideoReference(raw)).toBeNull());

  it('accepts at most 4096 URL characters, with no truncation', () => {
    const prefix = 'https://drive.google.com/';
    const exact = prefix + 'a'.repeat(4096 - prefix.length);
    expect(parseVideoReference(exact)?.url).toBe(exact);
    expect(parseVideoReference(exact + 'a')).toBeNull();
  });
});

describe('extractVideoReferences', () => {
  it('finds bare, Markdown and angle links without altering the caption', () => {
    const content = 'First https://youtu.be/abc.\n[Drive clip](https://drive.google.com/file/d/id/view?usp=sharing)\n<https://1drv.ms/v/abc?e=def>';
    expect(extractVideoReferences(content).map(x => x.url)).toEqual([
      'https://youtu.be/abc',
      'https://drive.google.com/file/d/id/view?usp=sharing',
      'https://1drv.ms/v/abc?e=def',
    ]);
    expect(content).toContain('[Drive clip]');
  });

  it('handles balanced parentheses and Markdown titles without shortening signed URLs', () => {
    const content = '[Cut](https://cdn.example.com/take(2).mp4?sig=x(y)#t=3)\n[Shared](https://1drv.ms/v/id?e=abc "Video")';
    expect(extractVideoReferences(content).map(x => x.url)).toEqual([
      'https://cdn.example.com/take(2).mp4?sig=x(y)#t=3',
      'https://1drv.ms/v/id?e=abc',
    ]);
  });

  it('keeps ambiguous query and fragment punctuation, rather than inventing a different URL', () => {
    const urls = ['https://1drv.ms/v/id?e=abc!', 'https://cdn.example.com/a.mp4?sig=abc.', 'https://vimeo.com/1#chapter:'];
    expect(extractVideoReferences(urls.join('\n')).map(x => x.url)).toEqual(urls);
  });

  it('de-duplicates normalized exact URLs but keeps query and fragment variants', () => {
    expect(extractVideoReferences('https://YOUTU.BE:443/a https://youtu.be/a https://youtu.be/a?t=1 https://youtu.be/a#t=1').map(x => x.url))
      .toEqual(['https://youtu.be/a', 'https://youtu.be/a?t=1', 'https://youtu.be/a#t=1']);
  });

  it('does not activate a URL substring of an unsafe or unrelated destination', () => {
    expect(extractVideoReferences('javascript:https://youtu.be/abc https://evil.example/?next=https://youtu.be/abc fakehttps://youtu.be/a')).toEqual([]);
  });

  it('skips overlong URL candidates whole and can find a later valid link', () => {
    const oversized = `https://drive.google.com/${'a'.repeat(4100)}`;
    expect(extractVideoReferences(`${oversized}\nhttps://youtu.be/ok`).map(x => x.url)).toEqual(['https://youtu.be/ok']);
    expect(extractVideoReferences(`[x](${oversized})`)).toEqual([]);
  });

  it('fails closed on oversized/malformed content without slicing into a URL', () => {
    expect(extractVideoReferences('x'.repeat(100001) + '\nhttps://youtu.be/abc')).toEqual([]);
    expect(extractVideoReferences({ content: 'https://youtu.be/abc' })).toEqual([]);
  });

  it('bounds display to ten unique references while duplicate checks scan all admitted text', () => {
    const urls = Array.from({ length: 20 }, (_, i) => `https://youtu.be/clip${i}`);
    const content = urls.join('\n');
    expect(extractVideoReferences(content)).toHaveLength(VIDEO_REFERENCE_LIMIT);
    expect(hasVideoReference(content, urls[19])).toBe(true);
    expect(hasVideoReference(content, 'https://YOUTU.BE:443/clip19')).toBe(true);
    expect(hasVideoReference(content, 'https://youtu.be/not-present')).toBe(false);
    expect(hasVideoReference(content, 'javascript:alert(1)')).toBe(false);
  });
});
