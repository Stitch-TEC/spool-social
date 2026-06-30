import React from 'react';

// Shared brand footer — one "Spool by Stitch TEC" lockup (real logo + correct casing) used across
// every Spool surface, replacing the old off-brand "Powered by Spool" line. Presentation only.
// Shown to clients on review links too, so the wording stays client-safe (no operator language).
const BrandFooter = ({ className = '' }) => (
  <footer className={`py-6 px-4 text-center border-t border-slate-200 bg-white ${className}`}>
    <div className="flex items-center justify-center gap-2">
      <img
        src="/stitch-tec-logo.png"
        alt="Stitch TEC"
        width={22}
        height={22}
        className="opacity-90"
        style={{ borderRadius: '50%', objectFit: 'cover' }}
      />
      <p className="text-slate-400 text-[11px] font-bold tracking-widest uppercase">
        Spool <span className="text-slate-300">by</span>{' '}
        <a
          href="https://stitchtec.dev"
          target="_blank"
          rel="noopener noreferrer"
          className="text-indigo-600 hover:text-indigo-800 transition-colors"
        >
          Stitch TEC
        </a>
      </p>
    </div>
  </footer>
);

export default BrandFooter;
