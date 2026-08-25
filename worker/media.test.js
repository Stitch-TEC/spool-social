import { describe, expect, it, vi } from 'vitest';
import {
  decodeImageBase64,
  inspectRasterImage,
  MAX_IMAGE_BYTES,
  mediaOriginConfig,
  normalizeSpoolMediaContentIdentity,
  resolveDraftImage,
  storeImage,
  UnsupportedRasterImageError,
  versionMediaMarkdownReferences,
  versionMediaReference,
} from './media.js';

const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const webp = () => new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const gif = () => new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);

describe('inspectRasterImage', () => {
  it('detects every supported raster from bytes and canonicalizes metadata', () => {
    expect(inspectRasterImage(png(), 'image/png')).toEqual({ mime: 'image/png', ext: 'png' });
    expect(inspectRasterImage(jpeg(), 'image/jpg')).toEqual({ mime: 'image/jpeg', ext: 'jpg' });
    expect(inspectRasterImage(webp(), 'image/webp')).toEqual({ mime: 'image/webp', ext: 'webp' });
    expect(inspectRasterImage(gif(), 'image/gif')).toEqual({ mime: 'image/gif', ext: 'gif' });
  });

  it('rejects active content even when the caller labels it as a PNG', () => {
    const html = new TextEncoder().encode('<!doctype html><script>alert(1)</script>');
    expect(() => inspectRasterImage(html, 'image/png')).toThrow(UnsupportedRasterImageError);
  });

  it('rejects a MIME claim that disagrees with valid raster bytes', () => {
    expect(() => inspectRasterImage(png(), 'image/jpeg')).toThrow('MIME does not match');
  });
});

describe('storeImage', () => {
  it('derives the R2 key and metadata from bytes', async () => {
    const env = {
      PUBLIC_ORIGIN: 'https://spool.example',
      MEDIA: {
        head: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
      },
    };
    const bytes = png();
    const stored = await storeImage(env, 'https://spool.example', bytes, 'image/png', 'owner', 'acme');

    expect(stored.key).toMatch(/^generated\/owner\/[0-9a-f]{64}\.png$/);
    expect(stored.url).toBe(`https://spool.example/media/v2/${stored.key}`);
    expect(env.MEDIA.put).toHaveBeenCalledWith(stored.key, bytes, {
      httpMetadata: { contentType: 'image/png' },
      customMetadata: {
        rasterValidated: 'v2',
        rasterMime: 'image/png',
        clientIds: 'acme',
      },
    });
  });

  it('enforces the central 5 MB byte ceiling before hashing or writing', async () => {
    const env = { PUBLIC_ORIGIN: 'https://spool.example', MEDIA: { head: vi.fn(), put: vi.fn() } };
    await expect(storeImage(
      env,
      'https://spool.example',
      new Uint8Array(MAX_IMAGE_BYTES + 1),
      'image/png',
      'owner'
    )).rejects.toMatchObject({ code: 'image_too_large', status: 413 });
    expect(env.MEDIA.head).not.toHaveBeenCalled();
    expect(env.MEDIA.put).not.toHaveBeenCalled();
  });

  it('refuses a caller-selected output origin before touching R2', async () => {
    const env = {
      PUBLIC_ORIGIN: 'https://spool.stitchtec.dev',
      MEDIA: { head: vi.fn(), put: vi.fn() },
    };
    await expect(storeImage(
      env,
      'https://attacker.example',
      png(),
      'image/png',
      'owner',
    )).rejects.toThrow(/must match PUBLIC_ORIGIN/);
    expect(env.MEDIA.head).not.toHaveBeenCalled();
    expect(env.MEDIA.put).not.toHaveBeenCalled();
  });

  it('fails before writing when bytes are not a supported raster', async () => {
    const env = { PUBLIC_ORIGIN: 'https://spool.example', MEDIA: { head: vi.fn(), put: vi.fn() } };
    await expect(storeImage(
      env,
      'https://spool.example',
      new TextEncoder().encode('<svg onload="alert(1)"></svg>'),
      'image/svg+xml',
      'owner'
    )).rejects.toMatchObject({ code: 'unsupported_image', status: 415 });
    expect(env.MEDIA.head).not.toHaveBeenCalled();
    expect(env.MEDIA.put).not.toHaveBeenCalled();
  });
});

describe('decodeImageBase64', () => {
  it('preflights decoded size before allocating the output buffer', () => {
    // Six base64 chars estimate to four decoded bytes; the test-sized ceiling
    // proves the same branch production uses with MAX_IMAGE_BYTES.
    expect(() => decodeImageBase64('AAAAAA==', 3))
      .toThrow(expect.objectContaining({ code: 'image_too_large', status: 413 }));
  });

  it('rejects an oversized draft/automation base64 payload before R2 access', async () => {
    const env = { PUBLIC_ORIGIN: 'https://spool.example', MEDIA: { head: vi.fn(), put: vi.fn() } };
    const oversized = 'A'.repeat(Math.ceil((MAX_IMAGE_BYTES + 1) / 3) * 4);
    await expect(resolveDraftImage(env, 'https://spool.example', { base64: oversized }))
      .rejects.toMatchObject({ code: 'image_too_large', status: 413 });
    expect(env.MEDIA.head).not.toHaveBeenCalled();
    expect(env.MEDIA.put).not.toHaveBeenCalled();
  });

  it('rejects conflicting data-URL and explicit MIME claims', async () => {
    const env = { PUBLIC_ORIGIN: 'https://spool.example', MEDIA: { head: vi.fn(), put: vi.fn() } };
    const dataUrl = `data:image/png;base64,${btoa(String.fromCharCode(...png()))}`;
    await expect(resolveDraftImage(env, 'https://spool.example', {
      base64: dataUrl,
      mime: 'image/jpeg',
    })).rejects.toMatchObject({ code: 'unsupported_image', status: 415 });
    expect(env.MEDIA.put).not.toHaveBeenCalled();
  });
});

describe('versionMediaMarkdownReferences', () => {
  it('versions canonical, explicitly legacy, and relative Spool images without trusting request-like origins', () => {
    const markdown = [
      '![canonical](https://spool.stitchtec.dev/media/generated/o/a.png)',
      '![legacy](https://spool.kist.workers.dev/media/library/o/acme/b.png)',
      '![unconfigured](https://spool.example/media/library/o/acme/no.png)',
      '![relative](/media/generated/o/c.png)',
      '![relative-v2](/media/v2/generated/o/e.png)',
      '<img src="/media/generated/o/raw.png" alt="raw">',
      '<img src="/media/v2/generated/o/raw-v2.png" alt="raw v2">',
      '![already](https://spool.stitchtec.dev/media/v2/generated/o/d.png)',
      '![external](https://cdn.example/media/e.png)',
      'Prose https://spool.stitchtec.dev/media/generated/o/prose.png stays literal.',
    ].join('\n');

    const versioned = versionMediaMarkdownReferences(
      'https://spool.stitchtec.dev',
      markdown,
      ['https://spool.kist.workers.dev'],
    );
    expect(versioned).toContain('https://spool.stitchtec.dev/media/v2/generated/o/a.png');
    expect(versioned).toContain('https://spool.stitchtec.dev/media/v2/library/o/acme/b.png');
    expect(versioned).toContain('https://spool.example/media/library/o/acme/no.png');
    expect(versioned).toContain('https://spool.stitchtec.dev/media/v2/generated/o/c.png');
    expect(versioned).toContain('https://spool.stitchtec.dev/media/v2/generated/o/e.png');
    expect(versioned).toContain('src="https://spool.stitchtec.dev/media/v2/generated/o/raw.png"');
    expect(versioned).toContain('src="https://spool.stitchtec.dev/media/v2/generated/o/raw-v2.png"');
    expect(versioned).toContain('https://spool.stitchtec.dev/media/v2/generated/o/d.png');
    expect(versioned).toContain('https://cdn.example/media/e.png');
    expect(versioned).toContain('Prose https://spool.stitchtec.dev/media/generated/o/prose.png stays literal.');
    expect(versioned).not.toContain('/media/v2/v2/');
    expect(versionMediaReference('https://spool.stitchtec.dev', '/media/v2/generated/o/e.png'))
      .toBe('https://spool.stitchtec.dev/media/v2/generated/o/e.png');
    expect(versionMediaReference(
      'https://spool.stitchtec.dev',
      '//spool.kist.workers.dev/media/generated/o/protocol-relative.png',
      ['https://spool.kist.workers.dev'],
    )).toBe('https://spool.stitchtec.dev/media/v2/generated/o/protocol-relative.png');
  });

  it('shares the parsed destination set between downstream output and approval identity', () => {
    const origin = 'https://spool.stitchtec.dev';
    const legacy = ['https://spool.kist.workers.dev'];
    const content = [
      '[asset](</media/generated/link.png> "title")',
      '![cover][cover]',
      '',
      '[cover]: https://spool.kist.workers.dev/media/generated/ref.png',
      '<img src="/media/generated/raw.png" srcset="/media/generated/a.png 1x, /media/generated/b.png 2x">',
    ].join('\n');
    const output = versionMediaMarkdownReferences(origin, content, legacy);
    expect(normalizeSpoolMediaContentIdentity(origin, content, legacy))
      .toBe(normalizeSpoolMediaContentIdentity(origin, output, legacy));
    expect(output).toContain(`${origin}/media/v2/generated/link.png`);
    expect(output).toContain(`${origin}/media/v2/generated/ref.png`);
    expect(output).toContain(`${origin}/media/v2/generated/a.png 1x`);
  });

  it('versions browser-decoded source candidates and safely re-encodes escaped CommonMark targets', () => {
    const origin = 'https://spool.stitchtec.dev';
    const legacy = ['https://spool.kist.workers.dev'];
    const content = [
      '[download](/media/library/acme/a\\(b\\).png)',
      '<picture>',
      '  <source srcset="&#47media/generated/relative.png 1x, https://spool.kist.workers.dev/media/generated/legacy.png 2x, https://cdn.example/media/external.png 3x">',
      '</picture>',
    ].join('\n');

    const output = versionMediaMarkdownReferences(origin, content, legacy);
    expect(output).toContain(`${origin}/media/v2/library/acme/a%28b%29.png`);
    expect(output).toContain(`${origin}/media/v2/generated/relative.png 1x`);
    expect(output).toContain(`${origin}/media/v2/generated/legacy.png 2x`);
    expect(output).toContain('https://cdn.example/media/external.png 3x');
    expect(normalizeSpoolMediaContentIdentity(origin, content, legacy))
      .toBe(normalizeSpoolMediaContentIdentity(origin, output, legacy));
  });
});

describe('mediaOriginConfig', () => {
  it('keeps one exact output origin and an explicit input-only legacy allowlist', () => {
    expect(mediaOriginConfig({
      PUBLIC_ORIGIN: 'https://spool.stitchtec.dev',
      LEGACY_MEDIA_ORIGINS: 'https://spool.kist.workers.dev,https://spool.kist.workers.dev',
    })).toEqual({
      publicOrigin: 'https://spool.stitchtec.dev',
      legacyOrigins: ['https://spool.kist.workers.dev'],
    });
  });

  it('rejects configured aliases with a path instead of widening the boundary', () => {
    expect(() => mediaOriginConfig({ LEGACY_MEDIA_ORIGINS: 'https://example.com/path' }))
      .toThrow(/no path/);
  });
});
