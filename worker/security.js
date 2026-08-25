// Compatibility-safe response hardening for the Worker boundary. The CSP is a
// deliberate floor: it blocks embedding, plugins, and hostile <base> changes
// without restricting scripts/connect/frame sources that Firebase Auth needs.
const BASELINE_HEADERS = Object.freeze({
  'Content-Security-Policy': "object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
});

export function applySecurityHeaders(headers) {
  for (const [name, value] of Object.entries(BASELINE_HEADERS)) headers.set(name, value);
  return headers;
}

export function withSecurityHeaders(response) {
  const headers = applySecurityHeaders(new Headers(response.headers));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function forceMediaDownload(headers, key) {
  const rawName = String(key || '').split('/').pop() || 'media';
  const filename = rawName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'media';
  headers.set('Content-Type', 'application/octet-stream');
  headers.set('Content-Disposition', `attachment; filename="${filename}.download"`);
  // Unsafe legacy objects must not reuse a previously cached inline response.
  headers.set('Cache-Control', 'no-store');
  return headers;
}
