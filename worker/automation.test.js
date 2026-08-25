import { afterEach, describe, expect, it, vi } from 'vitest';
import { rehostPageImage } from './automation.js';
import { MAX_IMAGE_BYTES } from './media.js';

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

afterEach(() => vi.restoreAllMocks());

describe('automation page-image ingestion bounds', () => {
  it('rejects a declared oversize before reading or writing it', async () => {
    const body = { getReader: vi.fn(() => { throw new Error('must not read'); }) };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({
        'Content-Type': 'image/png',
        'Content-Length': String(MAX_IMAGE_BYTES + 1),
      }),
      body,
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = { PUBLIC_ORIGIN: 'https://spool.example', MEDIA: { head: vi.fn(), put: vi.fn() } };

    await expect(rehostPageImage(env, 'https://spool.example', 'https://cdn.example/x.png', 'acme'))
      .resolves.toBe('');
    expect(body.getReader).not.toHaveBeenCalled();
    expect(env.MEDIA.put).not.toHaveBeenCalled();
  });

  it('streams a bounded valid raster through the central byte gate', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(png, {
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(png.byteLength) },
    }));
    const env = { PUBLIC_ORIGIN: 'https://spool.example', MEDIA: { head: vi.fn().mockResolvedValue(null), put: vi.fn() } };

    const url = await rehostPageImage(env, 'https://spool.example', 'https://cdn.example/x.png', 'acme');
    expect(url).toMatch(/^https:\/\/spool\.example\/media\/v2\/generated\/internal\/[a-f0-9]{64}\.png$/);
    expect(env.MEDIA.put).toHaveBeenCalledOnce();
  });
});
