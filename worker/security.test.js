import { describe, expect, it } from 'vitest';
import { applySecurityHeaders, forceMediaDownload, withSecurityHeaders } from './security.js';

describe('Worker response security', () => {
  it('adds the compatibility-safe baseline without replacing existing headers', async () => {
    const response = withSecurityHeaders(new Response('ok', {
      status: 201,
      headers: { 'Cache-Control': 'private' },
    }));

    expect(response.status).toBe(201);
    expect(await response.text()).toBe('ok');
    expect(response.headers.get('Cache-Control')).toBe('private');
    expect(response.headers.get('Strict-Transport-Security')).toContain('max-age=31536000');
    expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('forces a legacy non-raster object to download and disables its cache', () => {
    const headers = applySecurityHeaders(new Headers({ 'Content-Type': 'text/html' }));
    forceMediaDownload(headers, 'legacy/bad page.html');

    expect(headers.get('Content-Type')).toBe('application/octet-stream');
    expect(headers.get('Content-Disposition')).toBe('attachment; filename="bad_page.html.download"');
    expect(headers.get('Cache-Control')).toBe('no-store');
  });
});
