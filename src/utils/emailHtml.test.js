import { describe, it, expect } from 'vitest';
import { postToEmailHtml, mdInline, escapeHtml } from './emailHtml';

describe('postToEmailHtml', () => {
  it('renders title, hero image, headings, and paragraphs', () => {
    const html = postToEmailHtml({
      title: 'Big News',
      imageUrl: 'https://spool.stitchtec.dev/media/library/o/acme/hero.jpg',
      altText: 'Our team',
      content: '## Section\n\nHello **world** with [a link](https://x.io).',
    });
    expect(html).toContain('<h1>Big News</h1>');
    expect(html).toContain('src="https://spool.stitchtec.dev/media/library/o/acme/hero.jpg"');
    expect(html).toContain('alt="Our team"');
    expect(html).toContain('<h2>Section</h2>');
    expect(html).toContain('<strong>world</strong>');
    expect(html).toContain('<a href="https://x.io">a link</a>');
  });

  it('converts bulleted AND numbered lists', () => {
    const html = postToEmailHtml({ content: '- one\n- two\n\n1. first\n2. second' });
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(html).toContain('<ol><li>first</li><li>second</li></ol>');
  });

  it('converts blockquotes (post-escaping form) and horizontal rules', () => {
    const html = postToEmailHtml({ content: '> wise words\n> more words\n\n---\n\nafter' });
    expect(html).toContain('<blockquote>wise words<br>more words</blockquote>');
    expect(html).toContain('<hr>');
    expect(html).toContain('<p>after</p>');
  });

  it('drops a leading H1 that duplicates the title (no double headline)', () => {
    const html = postToEmailHtml({ title: 'My Post', content: '# My Post\n\nBody text' });
    expect(html.match(/<h1>/g)).toHaveLength(1);
    expect(html).toContain('<p>Body text</p>');
  });

  it('escapes HTML in content — markup arrives inert', () => {
    const html = postToEmailHtml({ content: 'Try <script>alert(1)</script> now' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('normalizes CRLF so blocks still split', () => {
    const html = postToEmailHtml({ content: 'one\r\n\r\ntwo' });
    expect(html).toContain('<p>one</p>');
    expect(html).toContain('<p>two</p>');
  });

  it('returns empty for an empty post', () => {
    expect(postToEmailHtml({})).toBe('');
    expect(postToEmailHtml({ content: '   ' })).toBe('');
  });

  it('never mutates plain-text idioms that merely LOOK like markdown', () => {
    // ">50%" is a comparison, not a quote — the > must survive.
    expect(postToEmailHtml({ content: '>50% of clients saw growth' }))
      .toContain('<p>&gt;50% of clients saw growth</p>');
    // "2025." starts a sentence, not item #2025 of a list.
    expect(postToEmailHtml({ content: '2025. What a year it was.' }))
      .toContain('<p>2025. What a year it was.</p>');
    // A five-star rating line is text, not a divider.
    expect(postToEmailHtml({ content: 'Rated *****' })).not.toContain('<hr>');
  });

  it('only treats a numbered block as a list when it starts at 1', () => {
    expect(postToEmailHtml({ content: '3. third\n4. fourth' })).not.toContain('<ol>');
    expect(postToEmailHtml({ content: '1. first\n2. second' })).toContain('<ol>');
  });

  it('a heading mid-block does not swallow the lines before it', () => {
    const html = postToEmailHtml({ content: '#hashtag promo line\n# Real heading' });
    expect(html).toContain('#hashtag promo line');
    expect(html).not.toContain('<h1>Real heading</h1>');
  });
});

describe('mdInline / escapeHtml', () => {
  it('only linkifies http(s) URLs', () => {
    expect(mdInline(escapeHtml('[x](javascript:alert(1))'))).not.toContain('<a ');
    expect(mdInline(escapeHtml('[x](https://ok.io)'))).toContain('<a href="https://ok.io">x</a>');
  });
});
