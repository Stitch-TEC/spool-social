import React, { useState } from 'react';
import { buildFeedbackPayload, submitFeedback, isValidEmail, stripHtml, isOnCooldown, stampCooldown } from '../lib/feedbackClient';

const FONT_DISPLAY = "'Outfit', system-ui, sans-serif";
const FONT_BODY = "'Inter', system-ui, sans-serif";
const GRADIENT_ACCENT = 'linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)';

// Shared feedback ingress Worker — spool.stitchtec.dev is an allowed CORS origin, so the login
// screen can POST an access request directly (no auth needed). It lands in POM's tickets queue as
// a 'request', matched to a client by email domain.

const LoginScreen = ({ onSignIn }) => {
  const [requestMode, setRequestMode] = useState(false);
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [status, setStatus] = useState('idle'); // idle | submitting | success | error
  const [msg, setMsg] = useState('');

  const submitRequest = async (e) => {
    e.preventDefault();
    if (!isValidEmail(email)) { setStatus('error'); setMsg('Please enter a valid email address.'); return; }
    if (isOnCooldown('lastAccessRequest')) {
      setStatus('error'); setMsg('Please wait a few minutes before requesting again.'); return;
    }
    setStatus('submitting'); setMsg('');
    try {
      const requestEmail = email.trim().toLowerCase();
      const payload = buildFeedbackPayload({
        app: 'spool',
        category: 'request',
        message: stripHtml(note.trim()).slice(0, 500) || 'Requesting access to Spool.',
        user: requestEmail,
        email: requestEmail,
      });
      await submitFeedback(payload);
      stampCooldown('lastAccessRequest');
      setStatus('success'); setMsg("Request sent — we'll be in touch shortly."); setEmail(''); setNote('');
    } catch (err) {
      console.error('Access request error:', err);
      setStatus('error'); setMsg('Something went wrong sending your request. Please try again later.');
    }
  };

  const inputStyle = {
    width: '100%', borderRadius: '10px', padding: '0.7rem 0.9rem',
    background: 'rgba(10,10,12,0.6)', border: '1px solid rgba(255,255,255,0.08)',
    color: '#f8f9fa', fontFamily: FONT_BODY, outline: 'none',
  };

  return (
    <div
      className="relative min-h-screen overflow-hidden flex flex-col items-center justify-center p-4"
      style={{ backgroundColor: '#0a0a0c', fontFamily: FONT_BODY }}
    >
      {/* Ambient engineering-grid backdrop */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px)',
          backgroundSize: '48px 48px',
        }}
      />
      {/* Soft radial blue glow behind the card */}
      <div
        className="pointer-events-none absolute left-1/2 top-1/2 h-[520px] w-[520px] -translate-x-1/2 -translate-y-1/2"
        style={{ background: 'radial-gradient(circle, rgba(59,130,246,0.55), transparent 70%)', filter: 'blur(40px)' }}
      />

      {/* Frosted-glass card */}
      <div
        className="relative w-full max-w-sm text-center px-8 py-10"
        style={{
          background: 'rgba(26,28,35,0.65)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '16px',
          boxShadow: '0 24px 64px rgba(0,0,0,0.55)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
        }}
      >
        {/* Lockup: circular logo + wordmark + app-name sub-label */}
        <div className="flex flex-col items-center mb-8">
          <img
            src="/stitch-tec-logo.png"
            alt="Stitch TEC"
            width={46}
            height={46}
            className="mb-4"
            style={{ borderRadius: '50%', objectFit: 'cover', boxShadow: '0 0 0 1px rgba(255,255,255,0.08), 0 8px 24px rgba(59,130,246,0.25)' }}
          />
          <div className="text-3xl font-bold leading-none" style={{ fontFamily: FONT_DISPLAY }}>
            <span style={{ color: '#f8f9fa' }}>Stitch </span>
            <span style={{ backgroundImage: GRADIENT_ACCENT, WebkitBackgroundClip: 'text', backgroundClip: 'text', WebkitTextFillColor: 'transparent', color: 'transparent' }}>TEC</span>
          </div>
          <div className="mt-3 text-xs" style={{ color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.2em', fontFamily: FONT_BODY }}>
            Spool
          </div>
        </div>

        {requestMode ? (
          status === 'success' ? (
            <div className="py-4">
              <p className="text-sm" style={{ color: '#10b981' }}>{msg}</p>
              <button onClick={() => { setRequestMode(false); setStatus('idle'); }} className="mt-4 text-sm hover:underline" style={{ color: '#3b82f6' }}>
                Back to sign in
              </button>
            </div>
          ) : (
            <form onSubmit={submitRequest} className="text-left space-y-3">
              <h2 className="text-lg font-semibold text-center" style={{ color: '#f8f9fa', fontFamily: FONT_DISPLAY }}>Request access</h2>
              {status === 'error' && (
                <div className="bg-red-500/10 border border-red-500/50 rounded-lg p-3 text-sm text-red-400 text-center">{msg}</div>
              )}
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" aria-label="Email address" style={inputStyle} />
              <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="What do you need access to? (optional)" rows={3} maxLength={500} aria-label="Message" style={{ ...inputStyle, resize: 'none' }} />
              <button type="submit" disabled={status === 'submitting'} className="w-full py-3 rounded-xl font-semibold transition-all disabled:opacity-50" style={{ backgroundImage: GRADIENT_ACCENT, color: '#fff', border: '1px solid rgba(255,255,255,0.10)' }}>
                {status === 'submitting' ? 'Sending…' : 'Send request'}
              </button>
              <button type="button" onClick={() => { setRequestMode(false); setStatus('idle'); setMsg(''); }} className="w-full text-sm hover:text-white transition-colors" style={{ color: '#9ca3af' }}>
                Cancel
              </button>
            </form>
          )
        ) : (
          <>
            <h1 className="text-xl font-semibold mb-2" style={{ color: '#f8f9fa', fontFamily: FONT_DISPLAY }}>Welcome back</h1>
            <p className="text-sm mb-8" style={{ color: '#9ca3af' }}>Creative workflow management</p>

            <button
              onClick={onSignIn}
              className="w-full py-3 rounded-xl font-semibold flex items-center justify-center gap-2 transition-all"
              style={{ backgroundImage: GRADIENT_ACCENT, color: '#ffffff', border: '1px solid rgba(255,255,255,0.10)', boxShadow: '0 8px 24px rgba(59,130,246,0.35)' }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="#ffffff" d="M21.35 11.1H12v3.2h5.35c-.23 1.4-1.6 4.1-5.35 4.1a5.9 5.9 0 1 1 0-11.8 5.3 5.3 0 0 1 3.75 1.45l2.2-2.2A8.9 8.9 0 0 0 12 3.2 8.8 8.8 0 1 0 12 20.8c5.08 0 8.45-3.57 8.45-8.6 0-.58-.05-1.02-.1-1.1Z" />
              </svg>
              Sign in with Google
            </button>

            <div className="mt-4 pt-4 border-t text-center" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
              <p className="text-sm mb-2" style={{ color: '#9ca3af' }}>Need access?</p>
              <button type="button" onClick={() => setRequestMode(true)} className="text-sm font-medium hover:underline" style={{ color: '#3b82f6' }}>
                Request access
              </button>
            </div>
          </>
        )}

        {/* Brand link back to the marketing site. */}
        <div className="mt-6">
          <a href="https://stitchtec.dev" target="_blank" rel="noopener noreferrer" className="text-xs transition-colors hover:text-white" style={{ color: '#6b7280' }}>
            stitchtec.dev ↗
          </a>
        </div>
      </div>
    </div>
  );
};

export default LoginScreen;
