import React, { useState, useEffect, useCallback } from 'react';
import {
  X, Zap, Plus, Loader2, Trash2, Play, Pause, PlayCircle, Clock, AlertCircle, ShieldCheck
} from 'lucide-react';
import { PLATFORMS, TONE_PRESETS, LENGTH_PRESETS, IMAGE_STYLE_PRESETS } from '../constants';
import { PLATFORM_CADENCE } from '../generation/prompts';
import { slugifyClientId } from '../config/roles';
import { DATE_FORMATTERS } from '../utils/helpers';
import useEscapeKey from '../hooks/useEscapeKey';
import {
  listAutomations as apiList,
  createAutomation as apiCreate,
  updateAutomation as apiUpdate,
  deleteAutomation as apiDelete,
  runAutomation as apiRun
} from '../utils/automationApi';

const CONTENT_TYPES = [
  { id: 'text', label: 'Text only' },
  { id: 'image', label: 'Image only' },
  { id: 'text+image', label: 'Text + image' }
];

const PLATFORM_IDS = Object.keys(PLATFORMS);

const fmtDate = (iso) => { try { return iso ? DATE_FORMATTERS.full.format(new Date(iso)) : '—'; } catch { return '—'; } };

/**
 * Super-admin only: set up scheduled, hands-off content generation for clients.
 * Each automation generates a review-ready draft (text and/or image) on its own
 * interval via the Worker's cron. Clients never see or control automations —
 * only the drafts they produce land in the client's normal review queue.
 *
 * The Worker re-verifies the caller is the operator; this UI is convenience.
 */
const AutomationsPanel = ({ onClose, uniqueClients = [], initialClient = '', clientIdByName = {}, showToast }) => {
  useEscapeKey(onClose);

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState(null); // row being toggled/run/deleted

  // Create form
  const [client, setClient] = useState(initialClient || uniqueClients[0] || '');
  const [platform, setPlatform] = useState('gmb');
  const [contentType, setContentType] = useState('text');
  const [tone, setTone] = useState('professional');
  const [length, setLength] = useState('medium');
  const [imageStyle, setImageStyle] = useState('photo');
  const [promptSeed, setPromptSeed] = useState('');
  const [intervalHours, setIntervalHours] = useState(PLATFORM_CADENCE.gmb.defaultHours);

  const cadence = PLATFORM_CADENCE[platform] || PLATFORM_CADENCE.gmb;
  const wantsImage = contentType.includes('image');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await apiList());
    } catch (err) {
      setError(err.message || 'Could not load automations');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // When the platform changes, reset the interval to that platform's sensible
  // default (each platform has a different minimum cadence).
  const onPlatformChange = (id) => {
    setPlatform(id);
    setIntervalHours((PLATFORM_CADENCE[id] || PLATFORM_CADENCE.gmb).defaultHours);
  };

  const handleCreate = async () => {
    if (creating) return;
    if (!client) { setError('Pick a client.'); return; }
    if (!promptSeed.trim()) { setError('Add a topic / instruction for the AI.'); return; }
    const clientId = clientIdByName[client] || slugifyClientId(client);
    if (!clientId) { setError('Could not resolve a client ID for that client.'); return; }

    setCreating(true);
    setError(null);
    try {
      const { automation } = await apiCreate({
        client, clientId, platform, contentType, tone, length, imageStyle,
        promptSeed: promptSeed.trim(),
        intervalHours: Number(intervalHours) || cadence.defaultHours
      });
      setItems(prev => [automation, ...prev]);
      setPromptSeed('');
      showToast?.('Automation created ⚡');
    } catch (err) {
      setError(err.message || 'Could not create automation');
    } finally {
      setCreating(false);
    }
  };

  const handleToggle = async (a) => {
    setBusyId(a.id);
    try {
      const { automation } = await apiUpdate(a.id, { enabled: !a.enabled });
      setItems(prev => prev.map(x => (x.id === a.id ? automation : x)));
      showToast?.(automation.enabled ? 'Automation resumed' : 'Automation paused');
    } catch (err) {
      showToast?.(err.message || 'Update failed', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleRun = async (a) => {
    setBusyId(a.id);
    try {
      await apiRun(a.id);
      showToast?.(`Draft generated for ${a.client} — check their review queue ✓`);
      refresh(); // reflect the updated lastRun / runCount
    } catch (err) {
      showToast?.(err.message || 'Run failed', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (a) => {
    if (!window.confirm(`Delete the ${PLATFORMS[a.platform]?.name || a.platform} automation for ${a.client}?`)) return;
    setItems(prev => prev.filter(x => x.id !== a.id)); // optimistic
    try {
      await apiDelete(a.id);
      showToast?.('Automation deleted');
    } catch (err) {
      showToast?.(err.message || 'Delete failed', 'error');
      refresh();
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Content automations" className="fixed inset-0 z-[90] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl flex flex-col max-h-[90vh]">
        <div className="p-5 border-b border-slate-100 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
            <Zap size={20} className="text-indigo-500" /> Content Automations
          </h2>
          <button onClick={onClose} aria-label="Close" className="p-2 text-slate-400 hover:bg-slate-100 rounded-full"><X size={20} /></button>
        </div>

        <div className="p-6 overflow-y-auto">
          {/* Create form */}
          <div className="border border-slate-200 rounded-xl p-4 mb-5">
            <h3 className="text-sm font-bold text-slate-700 mb-3">New automation</h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-slate-500 mb-1">Client</label>
                <select value={client} onChange={(e) => setClient(e.target.value)} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white">
                  {uniqueClients.length === 0 && <option value="">No clients yet</option>}
                  {uniqueClients.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-500 mb-1">Platform</label>
                <select value={platform} onChange={(e) => onPlatformChange(e.target.value)} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white">
                  {PLATFORM_IDS.map(id => <option key={id} value={id}>{PLATFORMS[id].name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-500 mb-1">Content</label>
                <select value={contentType} onChange={(e) => setContentType(e.target.value)} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white">
                  {CONTENT_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-500 mb-1">Tone</label>
                <select value={tone} onChange={(e) => setTone(e.target.value)} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white">
                  {TONE_PRESETS.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-500 mb-1">Length</label>
                <select value={length} onChange={(e) => setLength(e.target.value)} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white">
                  {LENGTH_PRESETS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
                </select>
              </div>
              {wantsImage && (
                <div>
                  <label className="block text-xs font-bold text-slate-500 mb-1">Image style</label>
                  <select value={imageStyle} onChange={(e) => setImageStyle(e.target.value)} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white">
                    {IMAGE_STYLE_PRESETS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
                  </select>
                </div>
              )}
              <div>
                <label className="block text-xs font-bold text-slate-500 mb-1">Every (hours)</label>
                <input
                  type="number" min={cadence.minHours} value={intervalHours}
                  onChange={(e) => setIntervalHours(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                />
                <p className="text-[11px] text-slate-400 mt-1">Min {cadence.minHours}h for {PLATFORMS[platform]?.name}.</p>
              </div>
            </div>

            <label className="block text-xs font-bold text-slate-500 mb-1 mt-3">Topic / instruction for the AI</label>
            <textarea
              value={promptSeed} onChange={(e) => setPromptSeed(e.target.value)} rows={2}
              placeholder="e.g. Highlight our contactless laser ultrasonic inspection for aerospace composites"
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm resize-y focus:ring-2 focus:ring-indigo-500"
            />

            {error && <p className="text-sm text-rose-600 mt-2">{error}</p>}

            <button
              onClick={handleCreate} disabled={creating || !client}
              className="mt-3 w-full flex items-center justify-center gap-2 bg-indigo-600 text-white py-2.5 rounded-xl font-bold text-sm shadow-md hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {creating ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />} Create automation
            </button>
          </div>

          {/* List */}
          {loading ? (
            <div className="flex justify-center py-6"><Loader2 className="animate-spin text-indigo-500" /></div>
          ) : items.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-6">No automations yet. Create one above.</p>
          ) : (
            <div className="space-y-2">
              {items.map(a => {
                const p = PLATFORMS[a.platform];
                const busy = busyId === a.id;
                return (
                  <div key={a.id} className="border border-slate-200 rounded-xl p-3">
                    <div className="flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-bold text-slate-800 truncate flex items-center gap-1.5">
                          {a.client}
                          <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${p ? p.color + ' text-white' : 'bg-slate-200 text-slate-600'}`}>{p?.name || a.platform}</span>
                          {!a.enabled && <span className="text-[10px] font-bold uppercase text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded">Paused</span>}
                        </p>
                        <p className="text-xs text-slate-500 mt-0.5 truncate">{a.contentType.replace('+', ' + ')} · every {a.intervalHours}h · {a.tone}/{a.length}</p>
                        <p className="text-[11px] text-slate-400 mt-1 flex items-center gap-1.5 flex-wrap">
                          <Clock size={11} /> Next {a.enabled ? fmtDate(a.nextRunAt) : 'paused'}
                          <span className="text-slate-300">·</span>
                          {a.lastStatus === 'error'
                            ? <span className="text-rose-500 flex items-center gap-1"><AlertCircle size={11} /> Last run failed</span>
                            : <span>Ran {a.runCount || 0}×{a.lastRunAt ? `, last ${fmtDate(a.lastRunAt)}` : ''}</span>}
                        </p>
                        {a.lastStatus === 'error' && a.lastError && (
                          <p className="text-[11px] text-rose-500 mt-1 truncate" title={a.lastError}>{a.lastError}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button onClick={() => handleRun(a)} disabled={busy} title="Run now (generate one draft)" aria-label="Run now" className="p-2 rounded-lg text-indigo-500 hover:bg-indigo-50 disabled:opacity-40">
                          {busy ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
                        </button>
                        <button onClick={() => handleToggle(a)} disabled={busy} title={a.enabled ? 'Pause' : 'Resume'} aria-label={a.enabled ? 'Pause' : 'Resume'} className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 disabled:opacity-40">
                          {a.enabled ? <Pause size={16} /> : <PlayCircle size={16} />}
                        </button>
                        <button onClick={() => handleDelete(a)} disabled={busy} title="Delete" aria-label="Delete" className="p-2 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 disabled:opacity-40">
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="mt-5 flex items-start gap-2 text-xs text-slate-500 bg-slate-50 border border-slate-100 rounded-xl p-3">
            <ShieldCheck size={16} className="text-emerald-500 shrink-0 mt-0.5" />
            <span>Automations are operator-only — clients can’t see or control them. Each run drops a <b className="text-slate-700">draft</b> into the client’s review queue (pending approval); nothing posts automatically. API usage is capped to protect your generation quota.</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AutomationsPanel;
