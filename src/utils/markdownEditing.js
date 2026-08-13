// Markdown editing helpers shared by the editor toolbar, the Editor itself, and
// the Worker (double-H1 strip at publish/push time). The selection math lives in
// pure compute* functions so it's unit-testable; nothing here touches
// window/document at module scope (the Worker imports from this file).

/**
 * Replace [start, end) of a textarea with `text`, keeping the browser's native
 * undo stack when possible. execCommand('insertText') is deprecated but is the
 * ONLY API that both preserves undo and fires a real input event (so React's
 * controlled state syncs through the normal onChange). The fallback (jsdom,
 * engines that refuse insertText on textareas) syncs React via the native value
 * setter + a dispatched input event — undo is lost only on that path.
 */
export function replaceRange(ta, start, end, text, selStart = null, selEnd = null) {
  ta.focus();
  ta.setSelectionRange(start, end);
  let ok = false;
  try {
    ok = document.execCommand('insertText', false, text);
  } catch {
    ok = false;
  }
  if (!ok) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ta.value.slice(0, start) + text + ta.value.slice(end));
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (selStart != null) {
    // After React re-renders with the new value, restore the selection we want
    // (execCommand leaves the caret after the insert).
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(selStart, selEnd ?? selStart);
    });
  }
}

// Shared wrap configs — the toolbar buttons and the editor's ⌘B/⌘I/⌘K
// shortcuts must produce identical markdown, so there is exactly one source.
export const WRAPS = {
  bold: { before: '**', after: '**', ph: 'bold text' },
  italic: { before: '*', after: '*', ph: 'italic text' },
  code: { before: '`', after: '`', ph: 'code' },
  link: { before: '[', after: '](https://)', ph: 'link text' },
};

/**
 * Inline wrap (bold/italic/code/link) with toggle-off: re-applying to a
 * selection that is already wrapped — whether the markers are inside or just
 * outside the selection — unwraps instead of stacking markers.
 * Returns { start, end, text, selStart, selEnd } for replaceRange.
 */
export function computeWrapToggle(value, s, e, cfg) {
  const { before, after, ph } = cfg;
  const sel = value.slice(s, e);
  // Emphasis-nesting guard: italic's single * must never "unwrap" one star of a
  // bold **…** run — an adjacent same-char marker means we're inside a longer
  // run, so fall through to wrapping (which correctly nests: ***bold-italic***).
  const star = before === '*';
  // "**bold**" selected → unwrap.
  if (sel.length >= before.length + after.length && sel.startsWith(before) && sel.endsWith(after)
    && !(star && sel.length >= 4 && sel.startsWith('**') && sel.endsWith('**'))) {
    const inner = sel.slice(before.length, sel.length - after.length);
    return { start: s, end: e, text: inner, selStart: s, selEnd: s + inner.length };
  }
  // "bold" selected inside **bold** → unwrap the surrounding markers.
  if (s - before.length >= 0
    && value.slice(s - before.length, s) === before
    && value.slice(e, e + after.length) === after
    && !(star && (value[s - before.length - 1] === '*' || value[e + after.length] === '*'))) {
    return {
      start: s - before.length, end: e + after.length, text: sel,
      selStart: s - before.length, selEnd: s - before.length + sel.length,
    };
  }
  const content = sel || ph;
  return {
    start: s, end: e, text: before + content + after,
    selStart: s + before.length, selEnd: s + before.length + content.length,
  };
}

// Line-prefix kinds. `detect` is level-exact for headings (/^\s*##\s/ does not
// match "### x" because the char after ## is '#', not whitespace) and tolerates
// leading indentation (markdown allows up to 3 spaces before a heading).
export const LINE_KINDS = {
  h1: { prefix: '# ', detect: /^\s*#\s+/, heading: true },
  h2: { prefix: '## ', detect: /^\s*##\s+/, heading: true },
  h3: { prefix: '### ', detect: /^\s*###\s+/, heading: true },
  ul: { prefix: '- ', detect: /^\s*[-*]\s+/ },
  ol: { numbered: true, detect: /^\s*\d+\.\s+/ },
  quote: { prefix: '> ', detect: /^\s*>\s?/ },
};

/**
 * Line-prefix op (headings/lists/quote) across EVERY line the selection
 * touches, with toggle-off: if all selected non-empty lines already carry the
 * prefix, it's removed. Headings replace an existing level instead of stacking
 * ("# x" + H2 → "## x"). Ordered lists number sequentially.
 */
export function computeLineToggle(value, s, e, kind) {
  const lineStart = value.lastIndexOf('\n', s - 1) + 1;
  let lineEnd = value.indexOf('\n', Math.max(e, s));
  if (lineEnd === -1) lineEnd = value.length;
  // A selection ending exactly at a line start (trailing \n selected) must not
  // drag the next line into the operation.
  if (e > s && value[e - 1] === '\n') lineEnd = e - 1;
  const lines = value.slice(lineStart, lineEnd).split('\n');
  const nonEmpty = lines.filter((l) => l.trim() !== '');
  // Caret on a blank line (fresh document, new paragraph): just start the
  // construct — the behavior every toolbar user expects.
  if (nonEmpty.length === 0) {
    const prefix = kind.numbered ? '1. ' : kind.prefix;
    return { start: s, end: s, text: prefix, selStart: s + prefix.length, selEnd: s + prefix.length };
  }
  const allHave = nonEmpty.every((l) => kind.detect.test(l));
  let n = 0;
  const out = lines.map((l) => {
    if (l.trim() === '') return l;
    if (allHave) return l.replace(kind.detect, '');
    n += 1;
    const prefix = kind.numbered ? `${n}. ` : kind.prefix;
    // Adding never stacks: strip an existing same-kind marker (any heading
    // level for the heading kinds) before prepending, so extending a partially
    // marked selection normalizes it instead of producing "- - one".
    const cleaned = kind.heading ? l.replace(/^\s*#{1,6}\s+/, '') : l.replace(kind.detect, '');
    return prefix + cleaned;
  });
  const text = out.join('\n');
  return { start: lineStart, end: lineEnd, text, selStart: lineStart, selEnd: lineStart + text.length };
}

/** Fenced code block around the selection; re-applying to a fenced selection unwraps. */
export function computeCodeFence(value, s, e) {
  const sel = value.slice(s, e);
  const m = sel.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  if (m) return { start: s, end: e, text: m[1], selStart: s, selEnd: s + m[1].length };
  // Selection is the INSIDE of a fence — exactly how our own insert leaves the
  // selection — so re-applying must unwrap, not nest a fence in a fence. The
  // look-back tolerates a language tag on the opening fence (```js).
  const head = value.slice(Math.max(0, s - 24), s).match(/```[^\n]*\n$/);
  if (head && value.slice(e, e + 4) === '\n```') {
    const start = s - head[0].length;
    return { start, end: e + 4, text: sel, selStart: start, selEnd: start + sel.length };
  }
  const content = sel || 'code';
  const nlBefore = s > 0 && value[s - 1] !== '\n' ? '\n' : '';
  const nlAfter = e < value.length && value[e] !== '\n' ? '\n' : '';
  const text = `${nlBefore}\`\`\`\n${content}\n\`\`\`${nlAfter}`;
  const selStart = s + nlBefore.length + 4; // past ```\n
  return { start: s, end: e, text, selStart, selEnd: selStart + content.length };
}

/** GFM table skeleton at the cursor (own paragraph), caret in the first header cell. */
export function computeTableInsert(value, s) {
  const atLineStart = s === 0 || value[s - 1] === '\n';
  const prefix = atLineStart ? '' : '\n\n';
  const table = '| Column | Column |\n| --- | --- |\n|  |  |';
  const suffix = s >= value.length || value[s] !== '\n' ? '\n' : '';
  const selStart = s + prefix.length + 2;
  return { start: s, end: s, text: prefix + table + suffix, selStart, selEnd: selStart + 'Column'.length };
}

// --- Character counting -----------------------------------------------------

const URL_RE = /https?:\/\/\S+/g;

/**
 * X/Twitter weighted length: every URL counts 23 (t.co wrapping) regardless of
 * its real length; CJK and emoji count 2 — multi-codepoint emoji (ZWJ families,
 * flags) count 2 for the whole cluster, like X, not 2 per codepoint. Single-
 * weight ranges are twitter-text's config v3 (basic Latin through Hangul Jamo,
 * general punctuation, variation selectors). Known limit: scheme-less domains
 * ("example.com") count as plain text here though X t.co-wraps them to 23 —
 * matching that needs a TLD list; Spool never auto-posts, so the counter stays
 * conservative about what IS a URL rather than guessing.
 */
export function twitterLength(text) {
  const t = String(text || '').normalize('NFC');
  let len = 0;
  const stripped = t.replace(URL_RE, (m) => {
    // Trailing sentence punctuation isn't part of the URL — count it as text.
    const trail = (m.match(/[.,!?;:)\]]+$/) || [''])[0];
    len += 23;
    return trail;
  });
  const seg = typeof Intl !== 'undefined' && Intl.Segmenter
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;
  const graphemes = seg ? Array.from(seg.segment(stripped), (g) => g.segment) : [...stripped];
  for (const g of graphemes) {
    const cps = [...g].map((c) => c.codePointAt(0));
    // A multi-codepoint cluster with emoji machinery (ZWJ, VS16, emoji planes,
    // regional indicators) is ONE emoji on screen → weight 2 total.
    if (cps.length > 1 && cps.some((cp) => cp === 0x200D || cp === 0xFE0F || cp >= 0x1F000 || (cp >= 0x1F1E6 && cp <= 0x1F1FF))) {
      len += 2;
      continue;
    }
    for (const cp of cps) {
      const single = cp <= 4351
        || (cp >= 8192 && cp <= 8205)
        || (cp >= 8208 && cp <= 8223)
        || (cp >= 65024 && cp <= 65039);
      len += single ? 1 : 2;
    }
  }
  return len;
}

// --- Content sniffing (soft warnings, so keep both deliberately conservative) -

/**
 * Markdown syntax that would post as LITERAL characters on a plain-text social
 * channel. Only checks the constructs that read as obvious mistakes (**bold**,
 * [text](url) links, # headings, `code`) — "- " lists and single *emphasis* are
 * plausible intentional plain text and would over-warn.
 */
export function looksLikeSocialMarkdown(text) {
  const t = String(text || '');
  return /\*\*[^*\n]+\*\*/.test(t)
    || /\[[^\]\n]+\]\(https?:\/\//.test(t)
    || /^#{1,6}\s+\S/m.test(t)
    || /`[^`\n]+`/.test(t);
}

/**
 * Raw HTML/JSX (or MDX import/export) in long-form content. Spool's preview
 * renders it inert (react-markdown without rehype-raw), but the published site
 * WILL interpret it — the operator should know the preview isn't showing it.
 * Markdown autolinks (<https://…>) deliberately don't match.
 */
export function containsRawHtml(text) {
  const t = String(text || '');
  return /<[A-Za-z][\w.-]*(\s[^<>]*)?\/?>/.test(t) || /^(import|export)\s+\S/m.test(t);
}

// --- Double-H1 guard (Editor hint + Worker publish/push) ---------------------

const normalizeTitle = (s) => String(s || '')
  .toLowerCase()
  .replace(/[*_`~]/g, '') // markdown emphasis wrapping the same words
  .replace(/\s+/g, ' ')
  .replace(/[.!?:]+$/, '')
  .trim();

/**
 * If the markdown body OPENS with an H1 that duplicates the post's title field,
 * drop that line (AI drafts are told to start with an H1 while the title is a
 * separate field — published pages ended up titling themselves twice). A
 * leading H1 that says something DIFFERENT from the title is kept.
 */
export function stripLeadingDuplicateH1(md, title) {
  const text = String(md || '');
  const t = normalizeTitle(title);
  if (!t) return text;
  const m = text.match(/^\s*#\s+([^\n]+)\n?/);
  if (!m) return text;
  if (normalizeTitle(m[1]) !== t) return text;
  return text.slice(m[0].length).replace(/^\n+/, '');
}
