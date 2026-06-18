import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Tailwind-classed renderers so we don't depend on the typography plugin.
const components = {
  h1: (p) => <h1 className="text-2xl font-black text-slate-900 mt-5 mb-2" {...p} />,
  h2: (p) => <h2 className="text-xl font-bold text-slate-900 mt-4 mb-2" {...p} />,
  h3: (p) => <h3 className="text-lg font-bold text-slate-800 mt-3 mb-1.5" {...p} />,
  p: (p) => <p className="text-slate-700 text-sm leading-relaxed mb-3" {...p} />,
  ul: (p) => <ul className="list-disc pl-5 mb-3 text-sm text-slate-700 space-y-1" {...p} />,
  ol: (p) => <ol className="list-decimal pl-5 mb-3 text-sm text-slate-700 space-y-1" {...p} />,
  li: (p) => <li className="leading-relaxed" {...p} />,
  a: (p) => <a className="text-indigo-600 underline break-words" target="_blank" rel="noopener noreferrer" {...p} />,
  strong: (p) => <strong className="font-bold text-slate-900" {...p} />,
  em: (p) => <em className="italic" {...p} />,
  blockquote: (p) => <blockquote className="border-l-4 border-slate-200 pl-3 italic text-slate-500 my-3" {...p} />,
  hr: () => <hr className="border-slate-200 my-4" />,
  img: (p) => <img className="w-full rounded-lg border border-slate-200 my-3" loading="lazy" {...p} />,
  pre: (p) => <pre className="bg-slate-900 text-slate-100 rounded-lg p-3 text-xs overflow-x-auto my-3" {...p} />,
  // Inline code (no language- class) gets a chip; fenced blocks live inside <pre>.
  code: ({ className = '', ...p }) =>
    /language-/.test(className)
      ? <code className={`font-mono text-xs ${className}`} {...p} />
      : <code className="font-mono text-[0.85em] bg-slate-100 text-slate-800 rounded px-1 py-0.5" {...p} />,
  table: (p) => <table className="w-full text-sm border-collapse my-3" {...p} />,
  th: (p) => <th className="border border-slate-200 bg-slate-50 px-2 py-1 text-left font-semibold" {...p} />,
  td: (p) => <td className="border border-slate-200 px-2 py-1" {...p} />,
};

const MarkdownPreview = ({ content = '', title = '', imageUrl = '' }) => (
  <div className="w-full max-w-none">
    {title && <h1 className="text-2xl font-black text-slate-900 mb-3">{title}</h1>}
    {imageUrl && (
      <img
        src={imageUrl}
        alt={title || 'Cover image'}
        className="w-full max-h-72 object-cover rounded-lg border border-slate-200 mb-4"
      />
    )}
    {content ? (
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{content}</ReactMarkdown>
    ) : (
      <p className="text-slate-300 italic text-sm">Start writing to see a preview…</p>
    )}
  </div>
);

export default MarkdownPreview;
