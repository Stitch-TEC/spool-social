import React from 'react';
import {
  Bold, Italic, Heading1, Heading2, Heading3, List, ListOrdered, Link2, Quote,
  Code, SquareCode, Table, Image as ImageIcon,
} from 'lucide-react';
import {
  replaceRange, computeWrapToggle, computeLineToggle, computeCodeFence,
  computeTableInsert, LINE_KINDS, WRAPS,
} from '../utils/markdownEditing';

// Lightweight "WYSIWYG-ish" toolbar: inserts Markdown at the cursor/selection.
// Keeps content as portable Markdown (no heavy rich-text dependency). All ops
// go through replaceRange (execCommand insertText) so ⌘Z undoes a toolbar
// click the same as typing, and re-applying an op toggles it off.

// Shortcut hint in tooltips — same convention as Sender's builder ("Bold (⌘B)").
const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|od|ad)/i.test(navigator.platform || '');
const mod = isMac ? '⌘' : 'Ctrl+';

// Module-scope so it isn't recreated each render (react-hooks/static-components).
// onMouseDown preventDefault keeps the textarea selection from clearing on click.
const Btn = ({ onClick, title, children }) => (
  <button
    type="button"
    onMouseDown={(e) => e.preventDefault()}
    onClick={onClick}
    title={title}
    aria-label={title}
    className="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-white rounded-md"
  >
    {children}
  </button>
);

const Divider = () => <span className="w-px h-4 bg-slate-300 mx-1" />;

const MarkdownToolbar = ({ textareaRef, onImageRequest }) => {
  // The textarea is controlled, so ta.value IS the current content — reading it
  // directly avoids a stale `value` prop between fast consecutive clicks.
  const run = (compute) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const r = compute(ta.value, ta.selectionStart, ta.selectionEnd);
    replaceRange(ta, r.start, r.end, r.text, r.selStart, r.selEnd);
  };

  const wrap = (cfg) => run((v, s, e) => computeWrapToggle(v, s, e, cfg));
  const line = (kind) => run((v, s, e) => computeLineToggle(v, s, e, kind));

  return (
    <div className="flex flex-wrap items-center gap-0.5 mb-2 p-1 bg-slate-100 border border-slate-200 rounded-lg w-fit">
      <Btn onClick={() => line(LINE_KINDS.h1)} title="Heading 1"><Heading1 size={16} /></Btn>
      <Btn onClick={() => line(LINE_KINDS.h2)} title="Heading 2"><Heading2 size={16} /></Btn>
      <Btn onClick={() => line(LINE_KINDS.h3)} title="Heading 3"><Heading3 size={16} /></Btn>
      <Divider />
      <Btn onClick={() => wrap(WRAPS.bold)} title={`Bold (${mod}B)`}><Bold size={16} /></Btn>
      <Btn onClick={() => wrap(WRAPS.italic)} title={`Italic (${mod}I)`}><Italic size={16} /></Btn>
      <Divider />
      <Btn onClick={() => line(LINE_KINDS.ul)} title="Bulleted list"><List size={16} /></Btn>
      <Btn onClick={() => line(LINE_KINDS.ol)} title="Numbered list"><ListOrdered size={16} /></Btn>
      <Btn onClick={() => line(LINE_KINDS.quote)} title="Quote"><Quote size={16} /></Btn>
      <Divider />
      <Btn onClick={() => wrap(WRAPS.link)} title={`Insert link (${mod}K)`}><Link2 size={16} /></Btn>
      <Btn onClick={() => wrap(WRAPS.code)} title="Inline code"><Code size={16} /></Btn>
      <Btn onClick={() => run(computeCodeFence)} title="Code block"><SquareCode size={16} /></Btn>
      <Btn onClick={() => run((v, s) => computeTableInsert(v, s))} title="Table"><Table size={16} /></Btn>
      {onImageRequest && (
        <>
          <Divider />
          <Btn onClick={onImageRequest} title="Insert image from library"><ImageIcon size={16} /></Btn>
        </>
      )}
    </div>
  );
};

export default MarkdownToolbar;
