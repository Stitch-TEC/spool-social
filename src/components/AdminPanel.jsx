import React, { useState, useEffect, useCallback } from 'react';
import { collection, getDocs, doc, setDoc, deleteDoc } from 'firebase/firestore';
import { X, UserPlus, Trash2, Loader2, ShieldCheck } from 'lucide-react';
import { db } from '../config/firebase';
import { ROLES, slugifyClientId } from '../config/roles';
import useEscapeKey from '../hooks/useEscapeKey';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLE_LABELS = {
  [ROLES.SUPER_ADMIN]: 'Operator (super admin)',
  [ROLES.CLIENT_ADMIN]: 'Client admin',
  [ROLES.CLIENT]: 'Client member',
};

/**
 * Super-admin only: grant / revoke Spool access by writing users/{email} docs.
 * Mirrors the firestore.rules model — the rules are the real boundary; this UI
 * is the operator's convenience (the same writes scripts/admin.mjs performs).
 * Guards: a user can never edit/revoke their OWN doc here (rules also forbid it),
 * and clientId is required for client / client_admin roles.
 */
const AdminPanel = ({ onClose, currentEmail = '', showToast }) => {
  useEscapeKey(onClose);
  const myEmail = (currentEmail || '').toLowerCase();

  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState(ROLES.CLIENT);
  const [clientId, setClientId] = useState('');
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const snap = await getDocs(collection(db, 'users'));
      setUsers(snap.docs.map(d => ({ email: d.id, ...d.data() })).sort((a, b) => a.email.localeCompare(b.email)));
    } catch (err) {
      setError(err.message || 'Could not load users');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const needsClient = role === ROLES.CLIENT || role === ROLES.CLIENT_ADMIN;

  const handleGrant = async () => {
    if (saving) return;
    const target = email.toLowerCase().trim();
    if (!EMAIL_RE.test(target)) { setError('Enter a valid email address.'); return; }
    if (target === myEmail) { setError("You can't change your own access here."); return; }
    const cid = needsClient ? slugifyClientId(clientId) : '';
    if (needsClient && !cid) { setError('A client / client admin needs a client ID (slug).'); return; }

    setSaving(true);
    setError(null);
    try {
      const payload = { roles: [role], email: target, updatedAt: new Date().toISOString(), source: 'admin-ui' };
      if (needsClient) payload.clientId = cid;
      await setDoc(doc(db, 'users', target), payload);
      showToast?.(`Access granted: ${target}`);
      setEmail(''); setClientId('');
      await refresh();
    } catch (err) {
      setError(err.message || 'Could not grant access (check Firestore rules).');
    } finally {
      setSaving(false);
    }
  };

  const handleRevoke = async (target) => {
    if (target === myEmail) { showToast?.("You can't revoke your own access.", 'error'); return; }
    if (!window.confirm(`Revoke all Spool access for ${target}?`)) return;
    try {
      await deleteDoc(doc(db, 'users', target));
      showToast?.(`Access revoked: ${target}`);
      await refresh();
    } catch (err) {
      showToast?.(err.message || 'Revoke failed', 'error');
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Manage users" className="fixed inset-0 z-[90] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl flex flex-col max-h-[90vh]">
        <div className="p-5 border-b border-slate-100 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
            <ShieldCheck size={20} className="text-indigo-500" /> Manage Users
          </h2>
          <button onClick={onClose} aria-label="Close" className="p-2 text-slate-400 hover:bg-slate-100 rounded-full"><X size={20} /></button>
        </div>

        <div className="p-6 overflow-y-auto">
          {/* Grant form */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-2">
            <input
              type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="person@client.com"
              className="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500"
            />
            <select value={role} onChange={(e) => setRole(e.target.value)} className="px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white">
              <option value={ROLES.CLIENT}>{ROLE_LABELS[ROLES.CLIENT]}</option>
              <option value={ROLES.CLIENT_ADMIN}>{ROLE_LABELS[ROLES.CLIENT_ADMIN]}</option>
              <option value={ROLES.SUPER_ADMIN}>{ROLE_LABELS[ROLES.SUPER_ADMIN]}</option>
            </select>
            {needsClient ? (
              <input
                value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="client ID (e.g. cadden)"
                className="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500"
              />
            ) : (
              <div className="px-3 py-2 text-xs text-slate-400 italic flex items-center">Full access — no client scope</div>
            )}
            <button
              onClick={handleGrant} disabled={saving}
              className="flex items-center justify-center gap-2 bg-indigo-600 text-white py-2 rounded-lg font-bold text-sm hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <UserPlus size={16} />} Grant access
            </button>
          </div>
          {error && <p className="text-sm text-rose-600 mb-3">{error}</p>}

          {/* Users list */}
          <div className="mt-5">
            {loading ? (
              <div className="flex justify-center py-6"><Loader2 className="animate-spin text-indigo-500" /></div>
            ) : users.length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-6">No users yet.</p>
            ) : (
              <div className="space-y-1.5">
                {users.map(u => {
                  const roles = Array.isArray(u.roles) ? u.roles : [];
                  const label = roles.includes(ROLES.SUPER_ADMIN) ? ROLE_LABELS[ROLES.SUPER_ADMIN]
                    : roles.includes(ROLES.CLIENT_ADMIN) ? ROLE_LABELS[ROLES.CLIENT_ADMIN]
                    : roles.includes(ROLES.CLIENT) ? ROLE_LABELS[ROLES.CLIENT] : 'No role';
                  const isSelf = u.email === myEmail;
                  return (
                    <div key={u.email} className="flex items-center gap-3 border border-slate-200 rounded-xl px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-slate-800 truncate">{u.email}{isSelf && <span className="ml-2 text-[10px] font-bold text-indigo-500 uppercase">you</span>}</p>
                        <p className="text-xs text-slate-400">{label}{u.clientId ? ` · ${u.clientId}` : ''}</p>
                      </div>
                      <button
                        onClick={() => handleRevoke(u.email)} disabled={isSelf}
                        title={isSelf ? "You can't revoke your own access" : 'Revoke access'}
                        className="p-2 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="mt-5 flex items-start gap-2 text-xs text-slate-500 bg-slate-50 border border-slate-100 rounded-xl p-3">
            <ShieldCheck size={16} className="text-emerald-500 shrink-0 mt-0.5" />
            <span>Access is enforced in the database rules, not just here. A client / client admin can only see their own client's content. You can't change your own access from this screen.</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AdminPanel;
