// Authentication for the Spool API.
//
// Two ways to call /api:
//   1. Internal API key  — your own projects send `Authorization: Bearer <INTERNAL_API_KEY>`
//   2. Firebase ID token — the Spool web app sends the signed-in user's token
//
// Firebase tokens are verified properly (RS256 signature against Google's public
// keys + claim checks), so the browser never needs the internal key.

const JWK_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4;
  if (pad) s += '='.repeat(4 - pad);
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function b64urlToString(s) {
  return new TextDecoder().decode(b64urlToBytes(s));
}

// Cache Google's signing keys in-isolate (~1h) to avoid refetching every request.
let jwkCache = { exp: 0, keys: null };
async function getJwks(force) {
  const now = Date.now();
  if (!force && jwkCache.keys && now < jwkCache.exp) return jwkCache.keys;
  const res = await fetch(JWK_URL);
  const data = await res.json();
  jwkCache = { exp: now + 60 * 60 * 1000, keys: data.keys || [] };
  return jwkCache.keys;
}

export async function verifyFirebaseToken(token, projectId) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;

  let header, payload;
  try {
    header = JSON.parse(b64urlToString(h));
    payload = JSON.parse(b64urlToString(p));
  } catch {
    return null;
  }
  if (header.alg !== 'RS256' || !header.kid) return null;

  // On a kid miss, Google may have rotated signing keys — force one refetch
  // (bypassing the ~1h cache) before rejecting an otherwise-valid token.
  let jwk = (await getJwks()).find(k => k.kid === header.kid);
  if (!jwk) jwk = (await getJwks(true)).find(k => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(s),
    new TextEncoder().encode(`${h}.${p}`)
  );
  if (!valid) return null;

  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp <= now) return null;
  if (payload.aud !== projectId) return null;
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) return null;
  if (!payload.sub) return null;

  return payload; // payload.sub === Firebase uid
}

export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

/**
 * Decides which Firebase users may use the generation API.
 *   - Anonymous/guest tokens are ALWAYS rejected. (Share-link reviewers sign in
 *     anonymously; the public Firebase web config means anyone could otherwise
 *     mint an anonymous token and call the API.)
 *   - If ALLOWED_EMAILS is set (comma-separated), only those verified emails pass.
 *     Leave it empty to allow any non-anonymous (e.g. Google) sign-in.
 */
function isAuthorizedUser(payload, env) {
  if (payload.firebase?.sign_in_provider === 'anonymous') return false;

  const allow = (env.ALLOWED_EMAILS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  if (allow.length === 0) return true; // any non-anonymous user

  const email = (payload.email || '').toLowerCase();
  return payload.email_verified === true && allow.includes(email);
}

/**
 * Returns { principal, mode } on success, or null on failure.
 *   mode 'apikey'   → principal 'internal'
 *   mode 'firebase' → principal is the user's uid
 */
export async function authenticate(request, env) {
  const m = (request.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1];

  if (env.INTERNAL_API_KEY && timingSafeEqual(token, env.INTERNAL_API_KEY)) {
    return { principal: 'internal', mode: 'apikey' };
  }
  if (env.FIREBASE_PROJECT_ID) {
    const payload = await verifyFirebaseToken(token, env.FIREBASE_PROJECT_ID);
    if (payload && isAuthorizedUser(payload, env)) {
      return { principal: payload.sub, mode: 'firebase' };
    }
  }
  return null;
}
