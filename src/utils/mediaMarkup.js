import { parse, postprocess, preprocess } from 'micromark';
import { decodeString } from 'micromark-util-decode-string';
import { parseFragment } from 'parse5';

const MARKDOWN_DESTINATION_TYPES = new Map([
  ['resourceDestinationString', 'resource'],
  ['definitionDestinationString', 'definition'],
  ['autolinkProtocol', 'autolink'],
]);

const HTML_TOKEN_TYPES = new Set(['htmlFlow', 'htmlText']);
const MARKDOWN_UNSAFE = new Set(['\\', '"', "'", '`', '(', ')', '<', '>']);

const asciiWhitespace = (char) => (
  char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f'
);

// A transformed URL is written back into the destination token itself. Encode
// syntax-significant ASCII instead of assuming the transform returned a string
// that is safe in CommonMark's raw-destination grammar. In particular,
// encodeURIComponent deliberately leaves parentheses alone, while an escaped
// legacy key such as `a\(b\).png` would become an invalid or differently parsed
// destination if those escapes were simply discarded.
function encodeMarkdownDestination(value) {
  let output = '';
  for (const char of String(value)) {
    const code = char.codePointAt(0);
    output += code <= 0x20 || code === 0x7f || MARKDOWN_UNSAFE.has(char)
      ? `%${code.toString(16).toUpperCase().padStart(2, '0')}`
      : char;
  }
  return output;
}

function applyEdits(value, edits) {
  const unique = [...new Map(edits.map((edit) => [`${edit.start}:${edit.end}`, edit])).values()]
    .sort((a, b) => b.start - a.start || b.end - a.end);
  let output = value;
  let rightBoundary = value.length;
  for (const edit of unique) {
    // A malformed parser result must never let overlapping replacements splice
    // bytes from two syntactic constructs together.
    if (edit.start < 0 || edit.end > rightBoundary || edit.end <= edit.start) continue;
    output = `${output.slice(0, edit.start)}${edit.value}${output.slice(edit.end)}`;
    rightBoundary = edit.start;
  }
  return output;
}

/**
 * Transform the URL tokens selected by the HTML srcset parsing algorithm while
 * retaining the author's descriptors and spacing. The input here is already
 * the browser-decoded attribute value supplied by parse5, so character
 * references that produce spaces or commas affect tokenization exactly where
 * a browser sees them.
 */
function transformSrcset(value, transform, kind) {
  const edits = [];
  let position = 0;

  while (position < value.length) {
    // HTML's algorithm starts each candidate by skipping any mixture of ASCII
    // whitespace and commas.
    while (position < value.length && (asciiWhitespace(value[position]) || value[position] === ',')) position++;
    if (position >= value.length) break;

    const urlStart = position;
    while (position < value.length && !asciiWhitespace(value[position])) position++;
    let urlEnd = position;

    // Trailing commas delimit a descriptor-less candidate; internal commas are
    // URL data (notably data: URLs and query-string values).
    while (urlEnd > urlStart && value[urlEnd - 1] === ',') urlEnd--;
    if (urlEnd > urlStart) {
      const url = value.slice(urlStart, urlEnd);
      const next = transform(url, { kind, raw: url });
      if (typeof next === 'string' && next !== url) {
        edits.push({ start: urlStart, end: urlEnd, value: next });
      }
    }

    if (urlEnd !== position) continue;

    // Descriptor parsing has three states in HTML: descriptor, in-parens, and
    // after-descriptor. A comma ends a candidate only outside parentheses.
    let parentheses = 0;
    while (position < value.length) {
      const char = value[position];
      if (char === '(') parentheses++;
      else if (char === ')' && parentheses > 0) parentheses--;
      else if (char === ',' && parentheses === 0) {
        position++;
        break;
      }
      position++;
    }
  }

  return edits.length ? applyEdits(value, edits) : value;
}

function htmlAttributeValueSpan(source, location) {
  if (!Number.isInteger(location?.startOffset) || !Number.isInteger(location?.endOffset)) return null;
  const start = location.startOffset;
  const end = location.endOffset;
  if (start < 0 || end <= start || end > source.length) return null;

  let position = source.indexOf('=', start);
  if (position === -1 || position >= end) return null;
  position++;
  while (position < end && asciiWhitespace(source[position])) position++;
  if (position >= end) return null;

  const quote = source[position] === '"' || source[position] === "'" ? source[position++] : '';
  const valueStart = position;
  const valueEnd = quote && source[end - 1] === quote ? end - 1 : end;
  return valueEnd >= valueStart ? { start: valueStart, end: valueEnd, quote } : null;
}

function encodeHtmlAttributeValue(value, quote) {
  // Replacing the whole decoded value is what makes numeric references without
  // semicolons browser-correct. Re-escape it for the attribute's original quote
  // style so decoded ampersands/quotes cannot escape the value.
  let output = String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;');
  if (quote === '"') return output.replaceAll('"', '&quot;');
  if (quote === "'") return output.replaceAll("'", '&#39;');
  return output.replace(/[\t\n\f\r "'`=>]/g, (char) => `&#${char.charCodeAt(0)};`);
}

function collectHtmlEdits(source, transform) {
  let fragment;
  try {
    fragment = parseFragment(source, { sourceCodeLocationInfo: true });
  } catch {
    return [];
  }

  const edits = [];
  const inspect = (node) => {
    const tag = String(node?.tagName || '').toLowerCase();
    if (tag === 'img' || tag === 'source') {
      for (const attribute of node.attrs || []) {
        const name = String(attribute?.name || '').toLowerCase();
        const supportsAttribute = (tag === 'img' && name === 'src')
          || ((tag === 'img' || tag === 'source') && name === 'srcset');
        if (!supportsAttribute) continue;

        const location = node.sourceCodeLocation?.attrs?.[name]
          || node.sourceCodeLocation?.startTag?.attrs?.[name];
        const span = htmlAttributeValueSpan(source, location);
        if (!span) continue;

        const decoded = String(attribute.value || '');
        const kind = `html-${tag}-${name}`;
        const next = name === 'srcset'
          ? transformSrcset(decoded, transform, kind)
          : transform(decoded, { kind, raw: source.slice(span.start, span.end) });
        if (typeof next === 'string' && next !== decoded) {
          edits.push({
            start: span.start,
            end: span.end,
            value: encodeHtmlAttributeValue(next, span.quote),
          });
        }
      }
    }

    // Template descendants live in a separate document fragment. parse5 does
    // not put raw-text lookalikes (script/style/comments/attribute text) here as
    // elements, so traversing the parsed tree follows browser semantics.
    for (const child of node?.childNodes || []) inspect(child);
    if (node?.content) inspect(node.content);
  };
  inspect(fragment);
  return edits;
}

function htmlParseView(value, ranges) {
  const ordered = ranges.slice().sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const range of ordered) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }

  let output = '';
  let position = 0;
  for (const range of merged) {
    output += ' '.repeat(range.start - position);
    output += value.slice(range.start, range.end);
    position = range.end;
  }
  return `${output}${' '.repeat(value.length - position)}`;
}

/**
 * Transform only destinations that CommonMark parsed as inline links/images,
 * reference definitions, or autolinks, plus browser-parsed img/src,
 * img/srcset, and source/srcset attributes in raw HTML. Micromark and parse5
 * supply the source offsets; labels, titles, surrounding prose, and code remain
 * byte-for-byte intact.
 */
export function transformMediaDestinations(markup, transform) {
  const value = String(markup || '');
  let events;
  try {
    const chunks = preprocess()(value, undefined, true);
    events = postprocess(parse().document().write(chunks));
  } catch {
    return value;
  }

  const edits = [];
  const htmlRanges = [];
  for (const [phase, token] of events) {
    if (phase !== 'enter') continue;
    const start = token?.start?.offset;
    const end = token?.end?.offset;
    if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) continue;

    const markdownKind = MARKDOWN_DESTINATION_TYPES.get(token.type);
    if (markdownKind) {
      const raw = value.slice(start, end);
      const decoded = decodeString(raw);
      const next = transform(decoded, { kind: markdownKind, raw });
      if (typeof next === 'string' && next !== decoded) {
        edits.push({ start, end, value: encodeMarkdownDestination(next) });
      }
    } else if (HTML_TOKEN_TYPES.has(token.type)) htmlRanges.push({ start, end });
  }

  // Micromark can emit several inline HTML tokens for one browser context
  // (`<textarea>`, a tag-shaped text payload, then `</textarea>`). Parse all raw
  // HTML together and mask every non-HTML byte with same-length whitespace. That
  // preserves parse5's absolute offsets while preventing code/prose from being
  // mistaken for markup and retaining raw-text element state across tokens.
  if (htmlRanges.length) edits.push(...collectHtmlEdits(htmlParseView(value, htmlRanges), transform));

  return edits.length ? applyEdits(value, edits) : value;
}
