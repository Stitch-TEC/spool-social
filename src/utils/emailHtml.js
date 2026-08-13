// Post → email-safe HTML fragment (the Sender template push + the email
// preview tab — ONE converter, so the preview can never lie about the push).
// Deliberately a TINY markdown subset (headings, bulleted/numbered lists,
// blockquotes, horizontal rules, bold/italic, links, images, paragraphs):
// Sender's sanitizer strips anything exotic and its renderEmailDocument
// scaffold styles bare tags, so a simple fragment IS the correct target — a
// full md engine would add attack surface for zero fidelity gain. Everything
// is HTML-escaped FIRST; links/images require http(s) or data: (Sender
// extracts data URIs to R2 and re-hosts Spool media URLs). Output is a
// FRAGMENT — never a full document (a doctype would make Sender skip its
// 600px email scaffold). Lives in src/ so the Worker AND the vitest suite
// share it; nothing here touches the DOM.

import { stripLeadingDuplicateH1 } from './markdownEditing';

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function mdInline(escaped) {
  return escaped
    // images before links (shared bracket syntax); URLs were escaped, so match &quot; boundaries
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+|data:image\/[^)\s]+)\)/g, '<img src="$2" alt="$1">')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
}

export function postToEmailHtml(post) {
  // Normalize CRLF/CR first — pasted content is often \r\n, and the \n-only block split below
  // would otherwise see the ENTIRE post as one giant paragraph.
  let content = String(post?.content || '').replace(/\r\n?/g, '\n').trim();
  if (!content && !post?.title) return '';
  // The title renders as its own <h1> below — a body that OPENS by repeating it
  // (AI drafts are told to start with an H1) would put the headline in twice.
  if (post?.title) content = stripLeadingDuplicateH1(content, post.title);
  const parts = [];
  if (post.title) parts.push(`<h1>${escapeHtml(post.title)}</h1>`);
  // Hero image: hosted /media URLs are already absolute; data URLs are fine (Sender re-hosts them).
  const img = String(post.imageUrl || '');
  if (/^(https?:\/\/|data:image\/)/.test(img)) {
    parts.push(`<img src="${escapeHtml(img)}" alt="${escapeHtml(post.altText || '')}">`);
  }
  // NOTE: the content below is already HTML-escaped — line-anchored detection
  // must match the ESCAPED forms ("&gt;" for a blockquote's ">").
  for (const block of escapeHtml(content).split(/\n{2,}/)) {
    const b = block.trim();
    if (!b) continue;
    // Horizontal rule: a block that is just --- or ___ (checked before the
    // list detections — no whitespace follows the marker, so they'd fall to
    // <p>). Deliberately NOT ***: a five-star rating line ("*****") in a
    // social template must stay text, not become a divider.
    if (/^(-{3,}|_{3,})$/.test(b)) {
      parts.push('<hr>');
      continue;
    }
    // Heading = the FIRST LINE only, and the match must BE the first line
    // (h.index === 0): a startsWith('#') check would let "#hashtag promo"
    // followed by a real heading swallow the hashtag line entirely. No /s —
    // a dotall match would drag every following line into the heading; any
    // remainder renders as a normal paragraph below it.
    const h = b.match(/^(#{1,3})\s+(.+)$/m);
    if (h && h.index === 0) {
      const tag = h[1].length === 1 ? 'h1' : 'h2';
      parts.push(`<${tag}>${mdInline(h[2].trim())}</${tag}>`);
      const rest = b.slice(h[0].length).trim();
      if (rest) parts.push(`<p>${mdInline(rest).replace(/\n/g, '<br>')}</p>`);
      continue;
    }
    const lines = b.split('\n');
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      parts.push(`<ul>${lines.map((l) => `<li>${mdInline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`);
      continue;
    }
    // Ordered list — only when it STARTS AT 1 (the editor's toolbar always
    // emits 1.-first): "2025. What a year" is a sentence, not item 2025, and
    // <ol> restarts numbering at 1 so a mid-list block would mislabel anyway.
    if (/^\s*1\.\s+/.test(lines[0]) && lines.every((l) => /^\s*\d+\.\s+/.test(l))) {
      parts.push(`<ol>${lines.map((l) => `<li>${mdInline(l.replace(/^\s*\d+\.\s+/, ''))}</li>`).join('')}</ol>`);
      continue;
    }
    // Blockquote — "&gt;" is ">" post-escaping, and the space is REQUIRED:
    // ">50% off" is a comparison glyph, not a quote (eating that ">" silently
    // changes meaning inside the client's email tool). Lines join with <br>
    // inside one quote block.
    if (lines.every((l) => /^\s*&gt;\s/.test(l))) {
      parts.push(`<blockquote>${lines.map((l) => mdInline(l.replace(/^\s*&gt;\s/, ''))).join('<br>')}</blockquote>`);
      continue;
    }
    parts.push(`<p>${mdInline(b).replace(/\n/g, '<br>')}</p>`);
  }
  return parts.join('\n');
}
