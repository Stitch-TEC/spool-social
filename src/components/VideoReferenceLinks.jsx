import React, { useMemo } from 'react';
import { extractVideoReferences, VIDEO_REFERENCE_LIMIT } from '../utils/videoReferences';

/** External video/file references already present in the approved draft text.
 * Never embeds, fetches, stores, or rewrites any linked content. */
export default function VideoReferenceLinks({ content }) {
  const links = useMemo(() => extractVideoReferences(content), [content]);
  if (links.length === 0) return null;
  return (
    <section aria-label="Video links in this draft" className="min-w-0 rounded-xl border border-indigo-200 bg-indigo-50 p-3 space-y-3 [overflow-wrap:anywhere]">
      <h3 className="text-sm font-bold text-slate-900">Video links in this draft</h3>
      <p className="text-xs text-slate-700">Open a linked video or shared file to review it. Its source controls access and may ask you to sign in.</p>
      <ul className="space-y-2">
        {links.map((link, index) => (
          <li key={link.url}>
            <a href={link.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"
              className="flex min-h-11 min-w-0 flex-col justify-center rounded-lg border border-indigo-300 bg-white px-3 py-2 text-sm text-indigo-800 underline underline-offset-2 hover:bg-indigo-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-700">
              <span>Open link {index + 1} — {link.provider}</span>
              <span className="text-xs text-slate-700 no-underline">{link.hostname} · Opens in a new tab</span>
            </a>
          </li>
        ))}
      </ul>
      <p className="text-xs text-slate-700">External files can change behind the same link. Approval records this draft’s text and links, not a fixed video version. These links remain part of the draft text; Spool does not store the videos.</p>
      {links.length === VIDEO_REFERENCE_LIMIT && (
        <p className="text-xs text-slate-700">Showing up to {VIDEO_REFERENCE_LIMIT} supported links. Check the full draft for any others.</p>
      )}
    </section>
  );
}
