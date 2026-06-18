import React from 'react';
import { Bold, Italic, Heading2, List, Link2, Quote, Code } from 'lucide-react';

// Lightweight "WYSIWYG-ish" toolbar: inserts Markdown at the cursor/selection.
// Keeps content as portable Markdown (no heavy rich-text dependency).
const WRAP = {
  bold: { before: '**', after: '**', ph: 'bold text' },
  italic: { before: '*', after: '*', ph: 'italic text' },
  code: { before: '`', after: '`', ph: 'code' },
  link: { before: '[', after: '](https://)', ph: 'link text' },
};
const LINE = { h2: '## ', ul: '- ', quote: '> ' };

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

const MarkdownToolbar = ({ textareaRef, value, onChange }) => {
  const applyWrap = (cfg) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const s = ta.selectionStart, e = ta.selectionEnd;
    const sel = value.slice(s, e) || cfg.ph;
    const next = value.slice(0, s) + cfg.before + sel + cfg.after + value.slice(e);
    onChange(next);
    requestAnimationFrame(() => {
      ta.focus();
      const pos = s + cfg.before.length;
      ta.setSelectionRange(pos, pos + sel.length);
    });
  };

  const applyLine = (prefix) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const s = ta.selectionStart;
    const lineStart = value.lastIndexOf('\n', s - 1) + 1;
    const next = value.slice(0, lineStart) + prefix + value.slice(lineStart);
    onChange(next);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(s + prefix.length, s + prefix.length);
    });
  };

  return (
    <div className="flex items-center gap-0.5 mb-2 p-1 bg-slate-100 border border-slate-200 rounded-lg w-fit">
      <Btn onClick={() => applyLine(LINE.h2)} title="Heading"><Heading2 size={16} /></Btn>
      <Btn onClick={() => applyWrap(WRAP.bold)} title="Bold"><Bold size={16} /></Btn>
      <Btn onClick={() => applyWrap(WRAP.italic)} title="Italic"><Italic size={16} /></Btn>
      <span className="w-px h-4 bg-slate-300 mx-1" />
      <Btn onClick={() => applyLine(LINE.ul)} title="List"><List size={16} /></Btn>
      <Btn onClick={() => applyLine(LINE.quote)} title="Quote"><Quote size={16} /></Btn>
      <Btn onClick={() => applyWrap(WRAP.link)} title="Link"><Link2 size={16} /></Btn>
      <Btn onClick={() => applyWrap(WRAP.code)} title="Inline code"><Code size={16} /></Btn>
    </div>
  );
};

export default MarkdownToolbar;
