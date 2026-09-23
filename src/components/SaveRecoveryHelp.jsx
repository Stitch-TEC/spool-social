import { useLayoutEffect, useRef, useState } from 'react';
import { saveRecoveryReference } from '../utils/saveRecoveryReference';

export default function SaveRecoveryHelp({ record, scope, principalId, projectId, getUser }) {
  const [notice, setNotice] = useState(null);
  const mounted = useRef(false);
  const current = useRef(null);
  const user = getUser?.();
  const reference = user && !user.isAnonymous && user.uid === principalId
    ? saveRecoveryReference(record, scope, principalId, projectId) : '';
  useLayoutEffect(() => {
    mounted.current = true;
    current.current = { reference, user };
    return () => { mounted.current = false; current.current = null; };
  }, [reference, user, getUser]);
  if (!reference) return null;

  const copyReference = async () => {
    const request = current.current;
    const active = () => mounted.current && current.current === request && getUser?.() === request.user;
    if (!active()) return;
    try {
      await navigator.clipboard.writeText(reference);
      if (active()) setNotice({ reference, user: request.user, message: 'Save reference copied. Draft text and images are not included.' });
    } catch {
      if (active()) setNotice({ reference, user: request.user, message: 'Copy is unavailable. Select the reference below and copy it manually.' });
    }
  };

  return (
    <details className="rounded-lg border border-amber-300 p-3 text-xs text-amber-950 [overflow-wrap:anywhere]">
      <summary className="min-h-11 cursor-pointer content-center font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-800">Help with this save</summary>
      <div className="mt-2 space-y-3">
        <p>If checking cannot confirm the save, keep this recovery copy. Do not create another copy or clear browser storage.</p>
        <p>Use Copy text above to keep the text currently in the editor; images and settings are not included. Keep this device available for a manual review.</p>
        <p>For help from Stitch TEC, share the reference below privately. It includes the client and thread IDs, not your draft text, images or sign-in details. It is not proof that the latest edits were saved.</p>
        <label className="block font-bold">
          Save reference
          <textarea readOnly value={reference} rows={9} className="mt-1 block w-full min-w-0 rounded-lg border border-amber-300 bg-white p-3 font-mono text-xs text-slate-800" spellCheck={false} />
        </label>
        <button type="button" onClick={copyReference} className="min-h-11 rounded-full border border-amber-700 px-3 py-2 font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-800">Copy save reference</button>
        <p role="status">{notice?.reference === reference && notice?.user === user ? notice.message : ''}</p>
      </div>
    </details>
  );
}
