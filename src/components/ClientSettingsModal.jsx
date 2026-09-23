import React, { useRef, useState } from 'react';
import { X, Upload, Trash2, Palette, Save, Sparkles, Users, ArrowRight } from 'lucide-react';
import { doc, setDoc } from 'firebase/firestore';
import { db } from '../config/firebase';
import { processImageFile } from '../utils/helpers';
import { TONE_PRESETS } from '../constants';
import useEscapeKey from '../hooks/useEscapeKey';
import useAsyncRequest from '../hooks/useAsyncRequest';

const AI_FIELD_MAX = 600;

// Prop-level workspace/permission changes start a fresh form and invalidate all
// old requests. This is UI ownership, not a replacement for Firebase auth/rules.
const ClientSettingsModal = (props) => <ClientSettingsForm key={JSON.stringify([props.uid, !!props.isReadOnly])} {...props} />;

const ClientSettingsForm = ({ onClose, uniqueClients, clientMap, uid, isReadOnly, onMergeClient, clientIdFor }) => {
  const [selectedClient, setSelectedClient] = useState(uniqueClients[0] || '');
  const [newClientName, setNewClientName] = useState('');
  const [mergeTarget, setMergeTarget] = useState('');
  const [confirmMerge, setConfirmMerge] = useState(false);

  // ⚡ OPTIMIZATION: Initialize state from props to avoid unnecessary effect/re-render
  const initialSettings = (() => {
    const initial = uniqueClients[0];
    return (initial && clientMap[initial]) ? clientMap[initial] : {};
  })();

  const [logoUrl, setLogoUrl] = useState(initialSettings.logoUrl || '');
  const [brandColor, setBrandColor] = useState(initialSettings.brandColor || '#4f46e5');

  // AI content defaults — woven into every generation for this client.
  const [aiBrandVoice, setAiBrandVoice] = useState(initialSettings.aiBrandVoice || '');
  const [aiAudience, setAiAudience] = useState(initialSettings.aiAudience || '');
  const [aiTone, setAiTone] = useState(initialSettings.aiTone || 'professional');
  const [aiKeywords, setAiKeywords] = useState(initialSettings.aiKeywords || '');
  const [aiAvoid, setAiAvoid] = useState(initialSettings.aiAvoid || '');

  const [isSaving, setIsSaving] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessingLogo, setIsProcessingLogo] = useState(false);
  const [error, setError] = useState('');
  const saveBusy = useRef(false);
  const logoBusy = useRef(false);
  const logoRequests = useAsyncRequest(JSON.stringify([uid, selectedClient]));
  const saveRequests = useAsyncRequest(uid);

  const cancelLogo = () => {
    logoRequests.cancel();
    logoBusy.current = false;
    setIsProcessingLogo(false);
    setIsDragging(false);
  };
  const handleClose = () => {
    logoRequests.cancel();
    saveRequests.cancel();
    // This only ignores late UI callbacks; it cannot cancel a submitted write.
    onClose();
  };
  useEscapeKey(handleClose);

  const handleClientChange = (val) => {
    if (saveBusy.current || isReadOnly) return;
    cancelLogo();
    setError('');
    setSelectedClient(val);
    setMergeTarget('');
    setConfirmMerge(false);
    const s = (val && val !== 'NEW' && clientMap[val]) ? clientMap[val] : {};
    setLogoUrl(s.logoUrl || '');
    setBrandColor(s.brandColor || '#4f46e5');
    setAiBrandVoice(s.aiBrandVoice || '');
    setAiAudience(s.aiAudience || '');
    setAiTone(s.aiTone || 'professional');
    setAiKeywords(s.aiKeywords || '');
    setAiAvoid(s.aiAvoid || '');
  };

  const processLogo = async (file) => {
    if (saveBusy.current || isReadOnly || !file?.type.startsWith('image/')) return;
    // A second image, a client switch or a removal supersedes the first result.
    logoRequests.cancel();
    const request = logoRequests.begin('logo');
    if (!request) return;
    logoBusy.current = true;
    setIsProcessingLogo(true);
    setError('');
    try {
      const processedImage = await processImageFile(file);
      if (logoRequests.current(request)) setLogoUrl(processedImage);
    } catch {
      if (logoRequests.current(request)) setError('The logo could not be processed. Try another PNG or JPG image.');
    } finally {
      if (logoRequests.current(request)) {
        logoBusy.current = false;
        setIsProcessingLogo(false);
        logoRequests.finish(request);
      }
    }
  };

  const handleFileUpload = (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // Choosing the same file again should retry processing.
    void processLogo(file);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    void processLogo(e.dataTransfer.files?.[0]);
  };

  const handleSave = async () => {
    if (isReadOnly || saveBusy.current || logoBusy.current) return;
    const activeClient = (selectedClient === 'NEW' ? newClientName.trim() : selectedClient).replace(/\//g, '').slice(0, 50);
    if (!activeClient) return alert('Enter a valid client name');
    if (!uid) return alert('You must be signed in to save brand settings');

    // 🛡️ SECURITY: Validate brandColor format
    const hexRegex = /^#[0-9A-F]{6}$/i;
    if (brandColor && !hexRegex.test(brandColor)) {
      return alert('Invalid brand color format');
    }

    // Validate tone against known presets; trim/cap free-text AI fields.
    const safeTone = TONE_PRESETS.some(t => t.id === aiTone) ? aiTone : 'professional';
    const cap = (v) => (v || '').trim().slice(0, AI_FIELD_MAX);

    const request = saveRequests.begin('save');
    if (!request) return;
    saveBusy.current = true;
    setIsSaving(true);
    setError('');
    try {
      // 🔒 Per-user doc id keeps each workspace's branding isolated.
      const clientDocId = `${uid}__${encodeURIComponent(activeClient)}`;
      await setDoc(doc(db, 'clients', clientDocId), {
        uid,
        name: activeClient,
        // The immutable tenant key — client members and review guests query branding
        // by clientId, so a doc without it is invisible to everyone but the operator.
        clientId: clientMap?.[activeClient]?.clientId || clientIdFor?.(activeClient) || '',
        logoUrl: (logoUrl || '').slice(0, 500000),
        brandColor,
        aiBrandVoice: cap(aiBrandVoice),
        aiAudience: cap(aiAudience),
        aiTone: safeTone,
        aiKeywords: cap(aiKeywords),
        aiAvoid: cap(aiAvoid)
      }, { merge: true });
      if (saveRequests.current(request)) handleClose();
    } catch {
      if (saveRequests.current(request)) setError('Spool could not confirm these settings were saved. Your changes are still here. Try saving again, or close and check the settings before retrying.');
    } finally {
      if (saveRequests.current(request)) {
        saveBusy.current = false;
        setIsSaving(false);
        saveRequests.finish(request);
      }
    }
  };

  const fieldClass = 'w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-slate-50 focus:bg-white focus:ring-2 focus:ring-indigo-500 transition-all';

  return (
    <div role="dialog" aria-modal="true" aria-label="Client Brand Settings" className="fixed inset-0 z-[100] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden flex flex-col max-h-[90vh]">
        <div className="p-4 border-b border-slate-100 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
            <Palette size={20} className="text-indigo-500" />
            Client Brand Settings
          </h2>
          <button
            onClick={handleClose}
            aria-label="Close brand settings"
            className="p-2 text-slate-400 hover:bg-slate-100 rounded-full transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        <div className="p-6 overflow-y-auto w-full">
          <fieldset disabled={isSaving || isReadOnly} className="min-w-0">
          {/* Client Select */}
          <div className="mb-6">
            <label htmlFor="brand-client" className="block text-sm font-bold text-slate-700 mb-2">Select Client</label>
            <select
              id="brand-client"
              value={selectedClient}
              onChange={(e) => handleClientChange(e.target.value)}
              className="w-full px-4 py-2 border border-slate-200 rounded-lg text-sm bg-slate-50 focus:bg-white focus:ring-2 focus:ring-indigo-500 transition-all font-medium"
            >
              <optgroup label="Extracted From Threads">
                {uniqueClients.map(c => (
                   <option key={c} value={c}>{c}</option>
                ))}
              </optgroup>
              <optgroup label="Other">
                <option value="NEW">+ Add New Client Manually</option>
              </optgroup>
            </select>
          </div>

          {selectedClient === 'NEW' && (
            <div className="mb-6">
              <label htmlFor="brand-client-name" className="block text-sm font-bold text-slate-700 mb-2">Client Name</label>
              <input
                id="brand-client-name"
                type="text"
                placeholder="e.g. My Awesome Startup"
                maxLength={50}
                value={newClientName}
                onChange={(e) => { cancelLogo(); setError(''); setNewClientName(e.target.value); }}
                className="w-full px-4 py-2 border border-slate-200 rounded-lg text-sm bg-slate-50 focus:bg-white focus:ring-2 focus:ring-indigo-500 transition-all"
              />
            </div>
          )}

          {/* Logo Upload */}
          <div className="mb-6">
            <label className="block text-sm font-bold text-slate-700 mb-2">Brand Logo</label>
            <div
              className={`w-full h-32 rounded-xl border-2 border-dashed flex items-center justify-center relative overflow-hidden transition-all ${
                isDragging ? 'border-indigo-500 bg-indigo-50 scale-[1.02]' : 'border-slate-300 bg-slate-50 hover:bg-slate-100'
              }`}
              onDragOver={(e) => { e.preventDefault(); if (!saveBusy.current && !isReadOnly) setIsDragging(true); }}
              onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
              onDrop={handleDrop}
            >
              {!logoUrl ? (
                <label className="w-full h-full flex flex-col items-center justify-center cursor-pointer p-4 text-center">
                  <div className={`p-3 rounded-full mb-2 ${isDragging ? 'bg-indigo-100 text-indigo-600' : 'bg-slate-200 text-slate-500'}`}>
                    <Upload size={20} />
                  </div>
                  <p className={`text-xs font-medium ${isDragging ? 'text-indigo-600' : 'text-slate-500'}`}>
                    {isDragging ? 'Drop logo here' : 'Drop transparent PNG/JPG logo'}
                  </p>
                  <input type="file" aria-label="Choose brand logo" className="hidden" accept="image/*" onChange={handleFileUpload} />
                </label>
              ) : (
                <div className="relative w-full h-full p-2 bg-slate-100 flex items-center justify-center">
                  <img src={logoUrl} className="max-w-full max-h-full object-contain" alt="Client Logo" />
                  <button
                    onClick={() => { cancelLogo(); setLogoUrl(''); setError(''); }}
                    title="Remove Logo"
                    className="absolute top-2 right-2 p-1.5 bg-black/50 text-white rounded-full hover:bg-rose-600 transition-colors backdrop-blur-sm"
                  >
                    <Trash2 size={14}/>
                  </button>
                </div>
              )}
            </div>
            {isProcessingLogo && <p role="status" className="text-xs text-slate-500 mt-2">Processing logo… Wait before saving, or choose a different image.</p>}
          </div>

          {/* Color Picker */}
          <div className="mb-6">
            <label className="block text-sm font-bold text-slate-700 mb-2">Primary Brand Color</label>
            <div className="flex gap-4 items-center">
              <input
                type="color"
                value={brandColor}
                onChange={(e) => setBrandColor(e.target.value)}
                className="w-12 h-12 rounded cursor-pointer border-0 p-0"
              />
              <div className="flex-1 font-mono text-sm tracking-wider uppercase text-slate-600 p-2 bg-slate-100 rounded border border-slate-200">
                {brandColor}
              </div>
            </div>
            <p className="text-xs text-slate-400 mt-2">Used for accents in previews (buttons, borders, etc.)</p>
          </div>

          {/* AI Content Defaults */}
          <div className="pt-2 border-t border-slate-100">
            <h3 className="text-sm font-bold text-slate-700 flex items-center gap-2 mb-1 mt-4">
              <Sparkles size={16} className="text-indigo-500" /> AI Content Defaults
            </h3>
            <p className="text-xs text-slate-400 mb-4">Pre-filled into every AI draft for this client.</p>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-600 mb-1">Brand Voice</label>
                <textarea
                  rows={2}
                  maxLength={AI_FIELD_MAX}
                  placeholder="e.g. Confident and technical, never salesy. Plain language over buzzwords."
                  value={aiBrandVoice}
                  onChange={(e) => setAiBrandVoice(e.target.value)}
                  className={`${fieldClass} resize-none`}
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-600 mb-1">Target Audience</label>
                <input
                  type="text"
                  maxLength={AI_FIELD_MAX}
                  placeholder="e.g. Aerospace QA engineers and procurement leads"
                  value={aiAudience}
                  onChange={(e) => setAiAudience(e.target.value)}
                  className={fieldClass}
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-600 mb-1">Default Tone</label>
                <select value={aiTone} onChange={(e) => setAiTone(e.target.value)} className={fieldClass}>
                  {TONE_PRESETS.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-600 mb-1">Keywords / themes to include</label>
                <input
                  type="text"
                  maxLength={AI_FIELD_MAX}
                  placeholder="e.g. contactless inspection, CFRP, turnaround time"
                  value={aiKeywords}
                  onChange={(e) => setAiKeywords(e.target.value)}
                  className={fieldClass}
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-600 mb-1">Words / topics to avoid</label>
                <input
                  type="text"
                  maxLength={AI_FIELD_MAX}
                  placeholder="e.g. emojis, exclamation points, competitor names"
                  value={aiAvoid}
                  onChange={(e) => setAiAvoid(e.target.value)}
                  className={fieldClass}
                />
              </div>
            </div>
          </div>

          {/* Rename / merge — reassigns every thread from this client to another name. */}
          {onMergeClient && selectedClient && selectedClient !== 'NEW' && (
            <div className="pt-4 mt-6 border-t border-slate-100">
              <h3 className="text-sm font-bold text-slate-700 flex items-center gap-2 mb-1">
                <Users size={16} className="text-indigo-500" /> Rename or merge
              </h3>
              <p className="text-xs text-slate-400 mb-3">
                Move every thread from <b className="text-slate-600">{selectedClient}</b> to another name — fix a typo, or merge two clients into one.
              </p>
              <input
                list="merge-target-list"
                type="text"
                maxLength={50}
                value={mergeTarget}
                onChange={(e) => { setMergeTarget(e.target.value); setConfirmMerge(false); }}
                placeholder="Target client name…"
                className={fieldClass}
              />
              <datalist id="merge-target-list">
                {uniqueClients.filter(c => c !== selectedClient).map(c => <option key={c} value={c} />)}
              </datalist>
              {(() => {
                const target = mergeTarget.trim();
                const valid = target && target !== selectedClient;
                const targetExists = uniqueClients.includes(target) || !!clientMap[target];
                if (!confirmMerge) {
                  return (
                    <button
                      disabled={!valid || isReadOnly}
                      onClick={() => setConfirmMerge(true)}
                      className="mt-2 flex items-center gap-1 text-sm font-bold text-indigo-600 hover:underline disabled:opacity-40 disabled:no-underline"
                    >
                      {targetExists ? `Merge into "${target}"` : `Rename to "${target}"`} <ArrowRight size={14} />
                    </button>
                  );
                }
                return (
                  <div className="mt-3 p-3 rounded-xl bg-amber-50 border border-amber-100">
                    <p className="text-xs text-amber-900 mb-2">
                      {targetExists
                        ? <>Merge <b>{selectedClient}</b> into <b>{target}</b>? Threads keep {target}'s brand settings.</>
                        : <>Rename <b>{selectedClient}</b> to <b>{target}</b>?</>}
                      <span className="block text-amber-700/80 mt-1">Curated media-library items stay under the old name.</span>
                    </p>
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => { onMergeClient(selectedClient, target); handleClose(); }}
                        className="px-3 py-1.5 bg-amber-600 text-white text-xs font-bold rounded-lg hover:bg-amber-700"
                      >
                        Confirm
                      </button>
                      <button onClick={() => setConfirmMerge(false)} className="text-xs font-medium text-slate-500 hover:text-slate-700">Cancel</button>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}

          </fieldset>
        </div>

        <div className="p-4 border-t border-slate-100 bg-slate-50 rounded-b-2xl">
          {error && <p role="alert" className="text-sm text-rose-700 mb-3">{error}</p>}
          {isSaving && <p role="status" className="text-xs text-slate-600 mb-3">Saving settings… Editing is paused. You can close this window; closing does not cancel the save.</p>}
          <div className="flex flex-wrap items-center justify-end gap-3">
          <button
            onClick={handleClose}
            className="px-4 py-2 font-bold text-slate-500 hover:text-slate-700 text-sm transition-colors"
          >
            {isSaving ? 'Close' : 'Cancel'}
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving || isProcessingLogo || (selectedClient === 'NEW' && !newClientName.trim()) || isReadOnly}
            className="flex items-center gap-2 bg-indigo-600 text-white px-5 py-2 font-bold rounded-lg text-sm shadow-md hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isSaving ? <span className="animate-pulse">Saving...</span> : <><Save size={16}/> Save Brand Info</>}
          </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ClientSettingsModal;
