import { describe, it, expect, vi } from 'vitest';
import {
  normalizeSpoolMediaContentIdentity,
  sameSpoolMediaReference,
  sortPosts,
  SORT_ORDERS,
  imageKey,
  PUBLIC_SPOOL_ORIGIN,
  versionMediaUrl,
  versionSpoolMediaContent,
} from './helpers';

describe('imageKey', () => {
  it('canonicalizes /media URLs to their R2 key across origins and encodings', () => {
    expect(imageKey('https://a.example/media/generated/u/abc.jpg')).toBe('generated/u/abc.jpg');
    expect(imageKey('https://a.example/media/v2/generated/u/abc.jpg')).toBe('generated/u/abc.jpg');
    expect(imageKey('/media/generated/u/abc.jpg?x=1')).toBe('generated/u/abc.jpg');
    expect(imageKey('https://b.example/media/library/o/my%20client/1.jpg')).toBe('library/o/my client/1.jpg');
  });

  it('passes data URLs and external URLs through unchanged', () => {
    expect(imageKey('data:image/png;base64,AAA')).toBe('data:image/png;base64,AAA');
    expect(imageKey('https://cdn.example/photo.jpg')).toBe('https://cdn.example/photo.jpg');
    expect(imageKey(undefined)).toBe(undefined);
  });
});

describe('versionMediaUrl', () => {
  it('canonicalizes relative, canonical, and explicit workers.dev legacy refs to PUBLIC_ORIGIN', () => {
    expect(versionMediaUrl('/media/generated/u/abc.jpg?x=1'))
      .toBe(`${PUBLIC_SPOOL_ORIGIN}/media/v2/generated/u/abc.jpg`);
    expect(versionMediaUrl('/media/v2/generated/u/abc.jpg'))
      .toBe(`${PUBLIC_SPOOL_ORIGIN}/media/v2/generated/u/abc.jpg`);
    expect(versionMediaUrl('https://spool.stitchtec.dev/media/library/o/acme/a.png'))
      .toBe(`${PUBLIC_SPOOL_ORIGIN}/media/v2/library/o/acme/a.png`);
    expect(versionMediaUrl('https://spool.kist.workers.dev/media/library/o/acme/b.png'))
      .toBe(`${PUBLIC_SPOOL_ORIGIN}/media/v2/library/o/acme/b.png`);
    expect(versionMediaUrl('//spool.kist.workers.dev/media/library/o/acme/c.png'))
      .toBe(`${PUBLIC_SPOOL_ORIGIN}/media/v2/library/o/acme/c.png`);
  });

  it('leaves unrelated third-party media paths unchanged', () => {
    expect(versionMediaUrl('https://cdn.example/media/photo.jpg')).toBe('https://cdn.example/media/photo.jpg');
    expect(versionMediaUrl('https://spool.example/media/photo.jpg')).toBe('https://spool.example/media/photo.jpg');
  });
});

describe('scoped Spool media identity', () => {
  it('keeps a large ordinary-copy snapshot on the parser-free fast path', () => {
    const ordinary = '# Update\n\nClient copy with [an external link](https://example.com). '.repeat(30);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (let i = 0; i < 500; i++) {
        expect(versionSpoolMediaContent(`${ordinary}${i}`)).toBe(`${ordinary}${i}`);
        expect(normalizeSpoolMediaContentIdentity(`${ordinary}${i}`)).toBe(`${ordinary}${i}`);
      }
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('equates only recognized Spool references across cache versions', () => {
    expect(sameSpoolMediaReference('/media/a.png', '/media/v2/a.png')).toBe(true);
    expect(sameSpoolMediaReference(
      'https://spool.stitchtec.dev/media/a.png',
      'https://spool.stitchtec.dev/media/v2/a.png'
    )).toBe(true);
    expect(sameSpoolMediaReference(
      'https://cdn.example/media/a.png',
      'https://cdn.example/media/v2/a.png'
    )).toBe(false);
  });

  it('versions only rendered Spool references in content', () => {
    const input = [
      '![spool](/media/generated/a.png)',
      '![external](https://cdn.example/media/a.png)',
      'prose /media/generated/a.png',
      '<img src="https://spool.stitchtec.dev/media/generated/b.png">',
    ].join('\n');
    expect(versionSpoolMediaContent(input)).toBe([
      `![spool](${PUBLIC_SPOOL_ORIGIN}/media/v2/generated/a.png)`,
      '![external](https://cdn.example/media/a.png)',
      'prose /media/generated/a.png',
      `<img src="${PUBLIC_SPOOL_ORIGIN}/media/v2/generated/b.png">`,
    ].join('\n'));
  });

  it('absolutizes already-v2 Markdown and raw img references for downstream rendering', () => {
    const input = '![cover](/media/v2/generated/a.png)\n<img src="/media/v2/generated/b.png">';
    expect(versionSpoolMediaContent(input)).toBe(
      `![cover](${PUBLIC_SPOOL_ORIGIN}/media/v2/generated/a.png)\n<img src="${PUBLIC_SPOOL_ORIGIN}/media/v2/generated/b.png">`
    );
  });

  it('normalizes rendered image targets but leaves identical-looking prose alone', () => {
    expect(normalizeSpoolMediaContentIdentity('![x](/media/a.png)'))
      .toBe(normalizeSpoolMediaContentIdentity('![x](/media/v2/a.png)'));
    expect(normalizeSpoolMediaContentIdentity('Mention /media/a.png'))
      .not.toBe(normalizeSpoolMediaContentIdentity('Mention /media/v2/a.png'));
  });

  it('parses every executable CommonMark/HTML destination without rewriting code or prose', () => {
    const input = [
      '![angle](</media/generated/angle.png> "Hero title")',
      '[download](/media/generated/download.png \'Download title\')',
      '[![nested](/media/generated/nested.png)](/media/generated/click.png)',
      '![reference][hero]',
      '',
      '[hero]: <https://spool.kist.workers.dev/media/generated/reference.png> "Reference title"',
      '<https://spool.stitchtec.dev/media/generated/autolink.png>',
      '<img SRC="/media/generated/raw.png" srcset="/media/generated/one.png 1x, /media/generated/query.png?crop=1,2 1.5x, https://cdn.example/media/no.png 2x, https://spool.kist.workers.dev/media/generated/two.png 3x">',
      '<!-- <img src="/media/generated/comment.png"> -->',
      '<script>const fake = \'<img src="/media/generated/script.png">\';</script>',
      '<div data-example=\'<img src="/media/generated/attribute.png">\'>safe</div>',
      '`![code](/media/generated/code.png)`',
      '```md',
      '![fenced](/media/generated/fenced.png)',
      '```',
      'Prose /media/generated/prose.png stays literal.',
    ].join('\n');

    const versioned = versionSpoolMediaContent(input);
    for (const key of ['angle', 'download', 'nested', 'click', 'reference', 'autolink', 'raw', 'one', 'query', 'two']) {
      expect(versioned).toContain(`${PUBLIC_SPOOL_ORIGIN}/media/v2/generated/${key}.png`);
    }
    expect(versioned).toContain('"Hero title"');
    expect(versioned).toContain("'Download title'");
    expect(versioned).toContain('"Reference title"');
    expect(versioned).toContain('https://cdn.example/media/no.png 2x');
    expect(versioned).toContain('<!-- <img src="/media/generated/comment.png"> -->');
    expect(versioned).toContain('<script>const fake = \'<img src="/media/generated/script.png">\';</script>');
    expect(versioned).toContain('<div data-example=\'<img src="/media/generated/attribute.png">\'>safe</div>');
    expect(versioned).toContain('`![code](/media/generated/code.png)`');
    expect(versioned).toContain('![fenced](/media/generated/fenced.png)');
    expect(versioned).toContain('Prose /media/generated/prose.png stays literal.');

    // Approval identity uses the same parsed destination set as output
    // canonicalization, so a pure v1/host migration is storage-only.
    expect(normalizeSpoolMediaContentIdentity(input))
      .toBe(normalizeSpoolMediaContentIdentity(versioned));
  });

  it('keeps the origin allowlist exact through decoded source/srcset and escaped destinations', () => {
    const input = [
      '[escaped](/media/library/acme/hero\\(wide\\).png)',
      '<picture>',
      '  <source srcset="&#47media/generated/relative.png 1x, https://spool.kist.workers.dev/media/generated/legacy.png 2x, https://cdn.example/media/external.png 3x">',
      '  <img src="https://spool.example/media/generated/unconfigured.png">',
      '</picture>',
    ].join('\n');
    const output = versionSpoolMediaContent(input);

    expect(output).toContain(`${PUBLIC_SPOOL_ORIGIN}/media/v2/library/acme/hero%28wide%29.png`);
    expect(output).toContain(`${PUBLIC_SPOOL_ORIGIN}/media/v2/generated/relative.png 1x`);
    expect(output).toContain(`${PUBLIC_SPOOL_ORIGIN}/media/v2/generated/legacy.png 2x`);
    expect(output).toContain('https://cdn.example/media/external.png 3x');
    expect(output).toContain('https://spool.example/media/generated/unconfigured.png');
    expect(normalizeSpoolMediaContentIdentity(input))
      .toBe(normalizeSpoolMediaContentIdentity(output));
  });
});

const p = (id, ts, created, client, platform) => ({
  id, _sortTs: ts, createdAt: new Date(created), client, platform,
});

// c has the middle schedule ts but Acme+blog; a is latest+Beta+gmb; b is earliest+Acme+linkedin
const posts = [
  p('a', 300, '2025-01-03T00:00:00Z', 'Beta', 'gmb'),
  p('b', 100, '2025-01-01T00:00:00Z', 'Acme', 'linkedin'),
  p('c', 200, '2025-01-02T00:00:00Z', 'Acme', 'blog'),
];
const ids = (arr) => arr.map((x) => x.id);

describe('sortPosts', () => {
  it('defaults to scheduled latest-first (and treats unknown keys the same)', () => {
    expect(ids(sortPosts(posts, SORT_ORDERS.SCHEDULED_DESC))).toEqual(['a', 'c', 'b']);
    expect(ids(sortPosts(posts, 'nonsense'))).toEqual(['a', 'c', 'b']);
    expect(ids(sortPosts(posts, undefined))).toEqual(['a', 'c', 'b']);
  });

  it('sorts scheduled soonest-first', () => {
    expect(ids(sortPosts(posts, SORT_ORDERS.SCHEDULED_ASC))).toEqual(['b', 'c', 'a']);
  });

  it('sorts by created date both directions', () => {
    expect(ids(sortPosts(posts, SORT_ORDERS.CREATED_DESC))).toEqual(['a', 'c', 'b']);
    expect(ids(sortPosts(posts, SORT_ORDERS.CREATED_ASC))).toEqual(['b', 'c', 'a']);
  });

  it('sorts by client A–Z, tiebreaking on most-recent schedule', () => {
    // Acme (c before b: 200>100), then Beta (a)
    expect(ids(sortPosts(posts, SORT_ORDERS.CLIENT_AZ))).toEqual(['c', 'b', 'a']);
  });

  it('sorts by platform name, tiebreaking on schedule', () => {
    // blog(c) < gmb(a) < linkedin(b)
    expect(ids(sortPosts(posts, SORT_ORDERS.PLATFORM))).toEqual(['c', 'a', 'b']);
  });

  it('is pure — never mutates the input array', () => {
    const before = ids(posts);
    sortPosts(posts, SORT_ORDERS.PLATFORM);
    expect(ids(posts)).toEqual(before);
  });

  it('tolerates a null/empty list', () => {
    expect(sortPosts(null, SORT_ORDERS.PLATFORM)).toEqual([]);
    expect(sortPosts([], SORT_ORDERS.SCHEDULED_ASC)).toEqual([]);
  });
});
