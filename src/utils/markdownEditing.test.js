import { describe, it, expect } from 'vitest';
import {
  computeWrapToggle, computeLineToggle, computeCodeFence, computeTableInsert,
  LINE_KINDS, twitterLength, looksLikeSocialMarkdown, containsRawHtml,
  stripLeadingDuplicateH1,
} from './markdownEditing';

const BOLD = { before: '**', after: '**', ph: 'bold text' };

const apply = ({ start, end, text }, value) => value.slice(0, start) + text + value.slice(end);

describe('computeWrapToggle', () => {
  it('wraps a selection and selects the inner text', () => {
    const v = 'make this bold now';
    const r = computeWrapToggle(v, 10, 14, BOLD);
    expect(apply(r, v)).toBe('make this **bold** now');
    expect(v.slice(10, 14)).toBe('bold');
    expect(r.selStart).toBe(12);
    expect(r.selEnd).toBe(16);
  });

  it('inserts a placeholder when nothing is selected', () => {
    const r = computeWrapToggle('', 0, 0, BOLD);
    expect(r.text).toBe('**bold text**');
    expect(r.selStart).toBe(2);
  });

  it('unwraps when the markers are inside the selection', () => {
    const v = 'a **bold** b';
    const r = computeWrapToggle(v, 2, 10, BOLD);
    expect(apply(r, v)).toBe('a bold b');
  });

  it('unwraps when the markers sit just outside the selection', () => {
    const v = 'a **bold** b';
    const r = computeWrapToggle(v, 4, 8, BOLD);
    expect(apply(r, v)).toBe('a bold b');
  });

  it('italic on bold NESTS instead of eating one star of the bold run', () => {
    const ITALIC = { before: '*', after: '*', ph: 'italic text' };
    const v = 'x **bold** y';
    // "**bold**" fully selected…
    expect(apply(computeWrapToggle(v, 2, 10, ITALIC), v)).toBe('x ***bold*** y');
    // …and "bold" selected inside the markers.
    expect(apply(computeWrapToggle(v, 4, 8, ITALIC), v)).toBe('x ***bold*** y');
    // Plain italic still toggles off.
    expect(apply(computeWrapToggle('a *it* b', 2, 6, ITALIC), 'a *it* b')).toBe('a it b');
  });
});

describe('computeLineToggle', () => {
  it('prefixes every line the selection touches', () => {
    const v = 'one\ntwo\nthree';
    const r = computeLineToggle(v, 1, 9, LINE_KINDS.ul);
    expect(apply(r, v)).toBe('- one\n- two\n- three');
  });

  it('toggles the prefix OFF when all selected lines already have it', () => {
    const v = '- one\n- two';
    const r = computeLineToggle(v, 0, v.length, LINE_KINDS.ul);
    expect(apply(r, v)).toBe('one\ntwo');
  });

  it('numbers ordered lists sequentially and skips blank lines', () => {
    const v = 'a\n\nb';
    const r = computeLineToggle(v, 0, v.length, LINE_KINDS.ol);
    expect(apply(r, v)).toBe('1. a\n\n2. b');
  });

  it('replaces an existing heading level instead of stacking', () => {
    const v = '# Title';
    const r = computeLineToggle(v, 2, 2, LINE_KINDS.h2);
    expect(apply(r, v)).toBe('## Title');
  });

  it('does not drag the next line in when the selection ends at a line start', () => {
    const v = 'one\ntwo';
    const r = computeLineToggle(v, 0, 4, LINE_KINDS.quote); // "one\n" selected
    expect(apply(r, v)).toBe('> one\ntwo');
  });

  it('heading detection is level-exact (## does not match ### lines)', () => {
    expect(LINE_KINDS.h2.detect.test('### deep')).toBe(false);
    expect(LINE_KINDS.h2.detect.test('## two')).toBe(true);
  });

  it('inserts a bare prefix on an empty line instead of doing nothing', () => {
    expect(computeLineToggle('', 0, 0, LINE_KINDS.h1).text).toBe('# ');
    expect(computeLineToggle('above\n\nbelow', 6, 6, LINE_KINDS.ul).text).toBe('- ');
    expect(computeLineToggle('', 0, 0, LINE_KINDS.ol).text).toBe('1. ');
  });

  it('normalizes a partially-marked selection instead of stacking markers', () => {
    const v = '- one\ntwo';
    expect(apply(computeLineToggle(v, 0, v.length, LINE_KINDS.ul), v)).toBe('- one\n- two');
    const q = '> a\nb';
    expect(apply(computeLineToggle(q, 0, q.length, LINE_KINDS.quote), q)).toBe('> a\n> b');
    const n = '1. a\nb';
    expect(apply(computeLineToggle(n, 0, n.length, LINE_KINDS.ol), n)).toBe('1. a\n2. b');
  });

  it('replaces an indented heading instead of stacking in front of it', () => {
    const v = '  ## x';
    expect(apply(computeLineToggle(v, 3, 3, LINE_KINDS.h1), v)).toBe('# x');
  });
});

describe('computeCodeFence', () => {
  it('fences a selection on its own lines', () => {
    const v = 'before code after';
    const r = computeCodeFence(v, 7, 11);
    expect(apply(r, v)).toBe('before \n```\ncode\n```\n after');
  });

  it('unwraps an already-fenced selection', () => {
    const v = '```\nx\n```';
    const r = computeCodeFence(v, 0, v.length);
    expect(apply(r, v)).toBe('x');
  });

  it('round-trips: re-applying on the inner selection (how insert leaves it) unwraps', () => {
    const v0 = 'code';
    const r1 = computeCodeFence(v0, 0, 4);
    const v1 = apply(r1, v0); // ```\ncode\n```
    const r2 = computeCodeFence(v1, r1.selStart, r1.selEnd);
    expect(apply(r2, v1)).toBe('code');
  });

  it('unwraps around a language-tagged opening fence', () => {
    const v = '```js\nlet x\n```';
    const r = computeCodeFence(v, 6, 11); // "let x" selected
    expect(apply(r, v)).toBe('let x');
  });
});

describe('computeTableInsert', () => {
  it('inserts a GFM skeleton with the caret in the first header cell', () => {
    const r = computeTableInsert('', 0);
    expect(r.text).toContain('| --- | --- |');
    expect(r.text.startsWith('| Column')).toBe(true);
    expect(r.selStart).toBe(2);
  });

  it('pads with a blank line when inserted mid-paragraph', () => {
    const r = computeTableInsert('text', 4);
    expect(r.text.startsWith('\n\n|')).toBe(true);
  });
});

describe('twitterLength', () => {
  it('counts plain ASCII one per character', () => {
    expect(twitterLength('hello world')).toBe(11);
  });

  it('counts every URL as 23 regardless of its length', () => {
    expect(twitterLength('https://a.very.long.example.com/path/that/goes/on/forever')).toBe(23);
    expect(twitterLength('x https://a.io y')).toBe(23 + 4); // "x " + " y"
  });

  it('counts emoji and CJK as 2', () => {
    expect(twitterLength('😀')).toBe(2);
    expect(twitterLength('日本語')).toBe(6);
  });

  it('counts a whole ZWJ/flag emoji cluster as 2, not 2 per codepoint', () => {
    expect(twitterLength('👨‍👩‍👧')).toBe(2); // family: 5 codepoints, one glyph
    expect(twitterLength('🇺🇸')).toBe(2); // flag: 2 regional indicators
  });

  it('keeps trailing sentence punctuation out of the URL', () => {
    // "see " (4) + URL (23) + "," (1) + " ok" (3)
    expect(twitterLength('see https://x.io, ok')).toBe(31);
  });
});

describe('looksLikeSocialMarkdown', () => {
  it('flags bold, md links, headings, and inline code', () => {
    expect(looksLikeSocialMarkdown('this is **bold**')).toBe(true);
    expect(looksLikeSocialMarkdown('see [our site](https://x.io)')).toBe(true);
    expect(looksLikeSocialMarkdown('## Heading')).toBe(true);
    expect(looksLikeSocialMarkdown('run `npm i`')).toBe(true);
  });

  it('leaves plain text, bare URLs, and dash lists alone', () => {
    expect(looksLikeSocialMarkdown('Big sale! Visit https://x.io today')).toBe(false);
    expect(looksLikeSocialMarkdown('- point one\n- point two')).toBe(false);
    expect(looksLikeSocialMarkdown('5 * 3 = 15 and 2*2=4')).toBe(false);
  });
});

describe('containsRawHtml', () => {
  it('flags HTML tags and MDX imports', () => {
    expect(containsRawHtml('a <br> b')).toBe(true);
    expect(containsRawHtml('<YouTube id="x" />')).toBe(true);
    expect(containsRawHtml('import Chart from "./chart"')).toBe(true);
  });

  it('ignores plain text, comparisons, and markdown autolinks', () => {
    expect(containsRawHtml('salt < pepper but a > b')).toBe(false);
    expect(containsRawHtml('<https://example.com>')).toBe(false);
    expect(containsRawHtml('# Just markdown')).toBe(false);
  });
});

describe('stripLeadingDuplicateH1', () => {
  it('drops a leading H1 that duplicates the title (case/punctuation-insensitive)', () => {
    expect(stripLeadingDuplicateH1('# My Post!\n\nBody', 'my post')).toBe('Body');
  });

  it('keeps a leading H1 that says something different', () => {
    expect(stripLeadingDuplicateH1('# Other\n\nBody', 'My Post')).toBe('# Other\n\nBody');
  });

  it('is a no-op without a title, an H1, or when the H1 is not first', () => {
    expect(stripLeadingDuplicateH1('# X\nBody', '')).toBe('# X\nBody');
    expect(stripLeadingDuplicateH1('Body only', 'T')).toBe('Body only');
    expect(stripLeadingDuplicateH1('intro\n# T', 'T')).toBe('intro\n# T');
  });

  it('only strips H1, never deeper headings', () => {
    expect(stripLeadingDuplicateH1('## My Post\nBody', 'My Post')).toBe('## My Post\nBody');
  });
});
