import { describe, expect, it, vi } from 'vitest';
import { transformMediaDestinations } from './mediaMarkup';

const canonicalize = (url) => (
  url.startsWith('/media/') ? `https://spool.test/media/v2/${url.slice('/media/'.length)}` : url
);

describe('transformMediaDestinations', () => {
  it('uses CommonMark destination tokens even when labels contain code and raw HTML', () => {
    const input = [
      '[click `]` <em>raw</em>](/media/generated/click.png "Click title")',
      '![alt `]` <span>raw</span>](/media/generated/image.png)',
      '[![nested](/media/generated/nested.png)](/media/generated/outer.png)',
      '![reference][hero]',
      '',
      '[hero]: </media/generated/reference.png> "Reference title"',
      '<https://spool.test/media/absolute.png>',
      '`[code](/media/generated/code.png)`',
    ].join('\n');

    const transform = vi.fn((url) => {
      if (url === 'https://spool.test/media/absolute.png') {
        return 'https://spool.test/media/v2/absolute.png';
      }
      return canonicalize(url);
    });
    const output = transformMediaDestinations(input, transform);

    for (const key of ['click', 'image', 'nested', 'outer', 'reference']) {
      expect(output).toContain(`https://spool.test/media/v2/generated/${key}.png`);
    }
    expect(output).toContain('<https://spool.test/media/v2/absolute.png>');
    expect(output).toContain('[click `]` <em>raw</em>]');
    expect(output).toContain('"Click title"');
    expect(output).toContain('"Reference title"');
    expect(output).toContain('`[code](/media/generated/code.png)`');
    expect(transform).not.toHaveBeenCalledWith('/media/generated/code.png', expect.anything());
  });

  it('re-encodes escaped destination syntax after transforming the decoded URL', () => {
    const input = [
      '[click](/media/library/a\\(b\\).png "Title")',
      '![reference][hero]',
      '',
      '[hero]: </media/generated/ref\\(1\\).png>',
    ].join('\n');

    expect(transformMediaDestinations(input, canonicalize)).toBe([
      '[click](https://spool.test/media/v2/library/a%28b%29.png "Title")',
      '![reference][hero]',
      '',
      '[hero]: <https://spool.test/media/v2/generated/ref%281%29.png>',
    ].join('\n'));
  });

  it('uses browser-decoded img and source attributes, including semicolonless numeric references', () => {
    const input = [
      '<picture>',
      '  <source srcset="&#47media/generated/one.png 1x, /media/generated/query.png?crop=1,2 2x">',
      '  <img SRC=&#x2Fmedia/generated/raw.png srcset="https://cdn.example/no.png 1x, &#47media/generated/two.png 2x">',
      '</picture>',
    ].join('\n');

    const output = transformMediaDestinations(input, canonicalize);
    for (const key of ['one', 'query', 'raw', 'two']) {
      expect(output).toContain(`https://spool.test/media/v2/generated/${key}.png`);
    }
    expect(output).toContain('query.png?crop=1,2 2x');
    expect(output).toContain('https://cdn.example/no.png 1x');
    expect(output).not.toContain('&#47media/');
    expect(output).not.toContain('&#x2Fmedia/');
  });

  it('does not treat comments, raw-text contents, attributes, or code as HTML media elements', () => {
    const input = [
      '<!-- <img src="/media/generated/comment.png"> -->',
      '<script>const fake = \'<img src="/media/generated/script.png">\';</script>',
      'before <script>const inline = \'<img src="/media/generated/inline-script.png">\';</script> after',
      '<style>.x{background:url(/media/generated/style.png)}</style>',
      '<textarea><source srcset="/media/generated/textarea.png"></textarea>',
      'before <textarea><img src="/media/generated/inline-textarea.png"></textarea> after',
      '<div data-example="<img src=/media/generated/attribute.png>">safe</div>',
      '',
      '```html',
      '<img src="/media/generated/fenced.png">',
      '```',
    ].join('\n');

    expect(transformMediaDestinations(input, canonicalize)).toBe(input);
  });
});
