import React, { useId, useState } from 'react';
import { hasVideoReference, parseVideoReference } from '../utils/videoReferences';

// Convenience for the existing draft text field only. No upload, external request,
// attachment record, save or review action belongs to this component.
export default function VideoLinkComposer({ content = '', onInsert, disabled = false }) {
  const id = useId();
  const [url, setUrl] = useState('');
  const [message, setMessage] = useState(null);
  const insert = () => {
    if (disabled) return;
    const reference = parseVideoReference(url.trim());
    if (!reference) {
      setMessage({ error: true, text: 'Use a supported HTTPS sharing link or direct video-file URL. Local file paths and other links cannot be added here.' });
      return;
    }
    if (hasVideoReference(content, reference.url)) {
      setMessage({ text: 'This link is already in the draft text. Nothing was added.' });
      return;
    }
    let result;
    try { result = onInsert?.(reference.url); } catch { /* Preserve the input for manual recovery. */ }
    if (result === 'duplicate') {
      setMessage({ text: 'This link is already in the draft text. Nothing was added.' });
      return;
    }
    if (result !== 'inserted') {
      setMessage({ error: true, text: 'The link was not added. Keep this URL and try again when the draft is ready to edit.' });
      return;
    }
    setUrl('');
    setMessage({ text: 'Link added to draft text. Save to keep this change.' });
  };
  return (
    <details className="min-w-0 rounded-xl border border-slate-300 bg-slate-50 [overflow-wrap:anywhere]">
      <summary className="min-h-11 cursor-pointer px-3 py-3 text-sm font-semibold text-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">
        Add video link to draft text
      </summary>
      <div className="min-w-0 space-y-3 px-3 pb-3">
        <p id={`${id}-help`} className="text-sm text-slate-700">
          Paste a Google Drive, OneDrive, SharePoint, Dropbox, YouTube, Vimeo, or direct video-file link.
          {' '}The URL becomes part of the caption or body and is included when that text is copied, published, or used by draft AI tools. It is not a private attachment.
        </p>
        <p className="text-sm text-slate-600">
          Spool does not upload or check the video. Keep the source file available and share it with the reviewers who need access.
          {' '}The existing cover-image slot is separate, not video storage.
        </p>
        <div className="flex min-w-0 flex-wrap items-end gap-2">
          <label htmlFor={`${id}-url`} className="min-w-0 basis-48 grow text-sm font-medium text-slate-700">
            Video sharing link
            <input
              id={`${id}-url`}
              type="url"
              value={url}
              onChange={event => { setUrl(event.target.value); setMessage(null); }}
              onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); insert(); } }}
              disabled={disabled}
              aria-invalid={Boolean(message?.error)}
              aria-describedby={`${id}-help${message ? ` ${id}-message` : ''}`}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="https://drive.google.com/…"
              className="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-slate-500 bg-white px-3 py-2 text-base text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:opacity-60"
            />
          </label>
          <button type="button" disabled={disabled || !url.trim()} onClick={insert}
            className="min-h-11 min-w-11 max-w-full rounded-lg bg-indigo-700 px-3 py-2 text-sm font-semibold text-white whitespace-normal hover:bg-indigo-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:opacity-60">
            Insert link into draft text
          </button>
        </div>
        {message && <p id={`${id}-message`} role={message.error ? 'alert' : 'status'} className={`text-sm ${message.error ? 'text-rose-700' : 'text-slate-700'}`}>{message.text}</p>}
      </div>
    </details>
  );
}
