import React from 'react';

const FONT_DISPLAY = "'Outfit', system-ui, sans-serif";
const FONT_BODY = "'Inter', system-ui, sans-serif";
const GRADIENT_ACCENT = 'linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)';

const LoginScreen = ({ onSignIn }) => (
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
      style={{
        background:
          'radial-gradient(circle, rgba(59,130,246,0.55), transparent 70%)',
        filter: 'blur(40px)',
      }}
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
          style={{
            borderRadius: '50%',
            objectFit: 'cover',
            boxShadow: '0 0 0 1px rgba(255,255,255,0.08), 0 8px 24px rgba(59,130,246,0.25)',
          }}
        />
        <div
          className="text-3xl font-bold leading-none"
          style={{ fontFamily: FONT_DISPLAY }}
        >
          <span style={{ color: '#f8f9fa' }}>Stitch </span>
          <span
            style={{
              backgroundImage: GRADIENT_ACCENT,
              WebkitBackgroundClip: 'text',
              backgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              color: 'transparent',
            }}
          >
            TEC
          </span>
        </div>
        <div
          className="mt-3 text-xs"
          style={{
            color: '#9ca3af',
            textTransform: 'uppercase',
            letterSpacing: '0.2em',
            fontFamily: FONT_BODY,
          }}
        >
          Spool
        </div>
      </div>

      <h1
        className="text-xl font-semibold mb-2"
        style={{ color: '#f8f9fa', fontFamily: FONT_DISPLAY }}
      >
        Welcome back
      </h1>
      <p className="text-sm mb-8" style={{ color: '#9ca3af' }}>
        Creative workflow management
      </p>

      <button
        onClick={onSignIn}
        className="w-full py-3 rounded-xl font-semibold flex items-center justify-center gap-2 transition-all"
        style={{
          backgroundImage: GRADIENT_ACCENT,
          color: '#ffffff',
          border: '1px solid rgba(255,255,255,0.10)',
          boxShadow: '0 8px 24px rgba(59,130,246,0.35)',
        }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="#ffffff"
            d="M21.35 11.1H12v3.2h5.35c-.23 1.4-1.6 4.1-5.35 4.1a5.9 5.9 0 1 1 0-11.8 5.3 5.3 0 0 1 3.75 1.45l2.2-2.2A8.9 8.9 0 0 0 12 3.2 8.8 8.8 0 1 0 12 20.8c5.08 0 8.45-3.57 8.45-8.6 0-.58-.05-1.02-.1-1.1Z"
          />
        </svg>
        Sign in with Google
      </button>
    </div>
  </div>
);

export default LoginScreen;
