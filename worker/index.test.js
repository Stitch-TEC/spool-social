import { describe, expect, it, vi } from 'vitest';
import worker, {
  decodeAutoId,
  decodeShareToken,
  deleteWhere,
  draftListResponseBody,
  listR2ObjectsCompletely,
  purgeClient,
  runGC,
  serializedJsonBytes,
  serveSpaAsset,
  staleAssetRecoveryScript,
  symbolicErrorPayload,
} from './index.js';
import { collectPostImageReferences, readRunQueryDocuments } from './firestore.js';
import { MAX_IMAGE_BYTES } from './media.js';

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

const r2Object = (bytes, contentType, customMetadata = {}, contentDisposition = '') => ({
  httpEtag: '"etag-1"',
  size: bytes.byteLength,
  body: new ReadableStream({
    start(controller) { controller.enqueue(bytes); controller.close(); },
  }),
  customMetadata,
  writeHttpMetadata(headers) {
    headers.set('Content-Type', contentType);
    if (contentDisposition) headers.set('Content-Disposition', contentDisposition);
  },
});

const envFor = (object) => ({
  ALLOWED_ORIGINS: '*',
  PUBLIC_ORIGIN: 'https://spool.stitchtec.dev',
  LEGACY_MEDIA_ORIGINS: 'https://spool.kist.workers.dev',
  MEDIA: {
    get: vi.fn().mockResolvedValue(object),
    head: vi.fn().mockResolvedValue(object),
  },
});

describe('destructive inventory fail-closed behavior', () => {
  it('finishes and validates every R2 page before returning an inventory', async () => {
    const binding = {
      list: vi.fn()
        .mockResolvedValueOnce({ objects: [{ key: 'generated/a.png' }], truncated: true, cursor: 'next' })
        .mockResolvedValueOnce({ objects: [{ key: 'generated/b.png' }], truncated: false }),
    };
    await expect(listR2ObjectsCompletely(binding, { prefix: 'generated/' }))
      .resolves.toEqual([{ key: 'generated/a.png' }, { key: 'generated/b.png' }]);
    expect(binding.list).toHaveBeenNthCalledWith(2, { prefix: 'generated/', cursor: 'next' });

    binding.list.mockReset().mockResolvedValue({ objects: [], truncated: true });
    await expect(listR2ObjectsCompletely(binding, { prefix: 'generated/' }))
      .rejects.toThrow(/continuation cursor/);

    binding.list.mockReset().mockResolvedValue({
      objects: [{ key: 'library/owner/other/not-generated.png' }],
      truncated: false,
    });
    await expect(listR2ObjectsCompletely(binding, { prefix: 'generated/' }))
      .rejects.toThrow(/outside prefix/);
  });

  it('makes GC a no-op when either reference or object inventory is uncertain', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = {
      FIREBASE_SERVICE_ACCOUNT: 'present',
      MEDIA: { delete: vi.fn() },
      GC_GRACE_DAYS: '0',
    };
    await runGC(env, {
      listReferences: vi.fn().mockResolvedValue(new Set()),
      listObjects: vi.fn().mockRejectedValue(new Error('later page malformed')),
    });
    expect(env.MEDIA.delete).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('does not let an incomplete empty Firestore stream become an empty GC mark set', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = {
      FIREBASE_SERVICE_ACCOUNT: 'present',
      MEDIA: { delete: vi.fn(), list: vi.fn() },
      GC_GRACE_DAYS: '0',
    };
    await runGC(env, {
      listReferences: () => readRunQueryDocuments(new Response('[]')),
      listObjects: vi.fn(),
    });
    expect(env.MEDIA.delete).not.toHaveBeenCalled();
    expect(env.MEDIA.list).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('does not sweep when a projected Firestore reference has the wrong application type', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = {
      FIREBASE_SERVICE_ACCOUNT: 'present',
      MEDIA: { delete: vi.fn() },
      GC_GRACE_DAYS: '0',
    };
    const listObjects = vi.fn();
    await runGC(env, {
      listReferences: () => collectPostImageReferences([{
        fields: { content: { mapValue: { fields: {} } } },
      }]),
      listObjects,
    });
    expect(listObjects).not.toHaveBeenCalled();
    expect(env.MEDIA.delete).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('does not let an out-of-prefix R2 result drive GC or tenant purge deletion', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const list = vi.fn().mockResolvedValue([]);
    const remove = vi.fn();
    const media = {
      list: vi.fn().mockResolvedValue({
        objects: [{ key: 'library/owner/other/cross-tenant.png', uploaded: new Date(0) }],
        truncated: false,
      }),
      delete: vi.fn(),
    };

    await runGC({
      FIREBASE_SERVICE_ACCOUNT: 'present',
      MEDIA: media,
      GC_GRACE_DAYS: '0',
    }, { listReferences: vi.fn().mockResolvedValue(new Set()) });
    expect(media.delete).not.toHaveBeenCalled();

    const result = await purgeClient({ OWNER_UID: 'owner', MEDIA: media }, 'acme', { list, remove });
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ store: 'media', error: expect.stringMatching(/outside prefix/) }),
    ]));
    expect(remove).not.toHaveBeenCalled();
    expect(media.delete).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('rejects a capped lifecycle listing before issuing any delete', async () => {
    const docs = [{ name: 'projects/test/databases/(default)/documents/posts/a', fields: { clientId: 'acme' } }];
    docs.truncated = true;
    const remove = vi.fn();
    await expect(deleteWhere({}, 'posts', 'clientId', 'acme', null, {
      list: vi.fn().mockResolvedValue(docs),
      remove,
    })).rejects.toThrow(/listing capped.*no documents deleted/);
    expect(remove).not.toHaveBeenCalled();
  });

  it('preflights every purge store and performs no deletion if a later listing is capped', async () => {
    const list = vi.fn(async (_env, collection, field) => {
      const docs = [{
        name: `projects/test/databases/(default)/documents/${collection}/AAAAAAAAAAAAAAAAAAAA`,
        fields: { clientId: 'acme' },
      }];
      if (collection === 'automations' && field === 'clientId') docs.truncated = true;
      return docs;
    });
    const remove = vi.fn();
    const removeObjects = vi.fn();
    const result = await purgeClient({
      OWNER_UID: 'owner',
      MEDIA: {},
    }, 'acme', {
      list,
      remove,
      listObjects: vi.fn().mockResolvedValue([{ key: 'library/owner/acme/a.png' }]),
      removeObjects,
    });

    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ store: 'automations', error: expect.stringMatching(/listing capped/) }),
    ]));
    expect(Object.values(result.counts).every((count) => count === 0)).toBe(true);
    expect(remove).not.toHaveBeenCalled();
    expect(removeObjects).not.toHaveBeenCalled();
  });
});

describe('/media response hardening', () => {
  it('serves a verified raster inline with canonical MIME and baseline headers', async () => {
    const response = await worker.fetch(
      new Request('https://spool.example/media/v2/generated/o/good.png'),
      envFor(r2Object(png, 'image/png'))
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('Cache-Control')).toContain('immutable');
    expect(response.headers.get('Content-Disposition')).toBeNull();
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('detects a valid PNG from bytes even when legacy R2 metadata is wrong', async () => {
    const response = await worker.fetch(
      new Request('https://spool.example/media/v2/legacy/wrong-metadata.png'),
      envFor(r2Object(png, 'text/html', {}, 'attachment; filename="legacy.bin"'))
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('Content-Disposition')).toBeNull();
    expect(response.headers.get('Cache-Control')).toContain('immutable');
  });

  it('neutralizes legacy HTML even when its stored MIME claims it is a PNG', async () => {
    const html = new TextEncoder().encode('<!doctype html><script>alert(1)</script>');
    const response = await worker.fetch(
      new Request('https://spool.example/media/v2/legacy/attack.png'),
      envFor(r2Object(html, 'image/png'))
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(response.headers.get('Content-Disposition')).toContain('attachment');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).toContain('<script>');
  });

  it('redirects an uncached legacy URL onto v2 without caching the redirect', async () => {
    const env = envFor(r2Object(png, 'image/png'));
    const response = await worker.fetch(
      new Request('https://spool.kist.workers.dev/media/generated/o/good.png'),
      env
    );

    expect(response.status).toBe(308);
    expect(response.headers.get('Location'))
      .toBe('https://spool.stitchtec.dev/media/v2/generated/o/good.png');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(env.MEDIA.get).not.toHaveBeenCalled();
  });

  it('trusts HEAD metadata only when a new byte-validated write stamped it', async () => {
    const legacy = await worker.fetch(
      new Request('https://spool.example/media/v2/legacy/good.png', { method: 'HEAD' }),
      envFor(r2Object(png, 'image/png'))
    );
    expect(legacy.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(legacy.headers.get('Content-Disposition')).toContain('attachment');
    expect(legacy.headers.get('Cache-Control')).toBe('no-store');

    const trusted = await worker.fetch(
      new Request('https://spool.example/media/v2/generated/o/good.png', { method: 'HEAD' }),
      envFor(r2Object(png, 'text/html', {
        rasterValidated: 'v2',
        rasterMime: 'image/png',
      }))
    );
    expect(trusted.headers.get('Content-Type')).toBe('image/png');
    expect(trusted.headers.get('Content-Disposition')).toBeNull();
    expect(trusted.headers.get('Cache-Control')).toContain('immutable');
  });

  it('does not allocate an oversized legacy object and serves it only as a no-store attachment', async () => {
    const object = r2Object(new TextEncoder().encode('legacy'), 'image/png');
    object.size = MAX_IMAGE_BYTES + 1;
    const response = await worker.fetch(
      new Request('https://spool.example/media/v2/legacy/oversize.png'),
      envFor(object),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(response.headers.get('Content-Disposition')).toContain('attachment');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('stops an unknown-length legacy R2 stream at the byte ceiling', async () => {
    const object = r2Object(new Uint8Array(), 'image/png');
    delete object.size;
    object.body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(3_000_000));
        controller.enqueue(new Uint8Array(2_000_001));
        controller.close();
      },
    });
    const response = await worker.fetch(
      new Request('https://spool.example/media/v2/legacy/unknown-size.png'),
      envFor(object),
    );
    expect(response.status).toBe(413);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('returns a hardened 400 for malformed percent-encoding', async () => {
    for (const path of ['/media/%', '/media/v2/%']) {
      const response = await worker.fetch(
        new Request(`https://spool.example${path}`),
        envFor(null)
      );
      expect(response.status).toBe(400);
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      await expect(response.json()).resolves.toEqual({ error: 'Malformed media key' });
    }
  });
});

describe('Worker boundary responses', () => {
  it('passes a real hashed JavaScript asset through unchanged', async () => {
    const asset = 'export const current = true;';
    const response = await serveSpaAsset(
      new Request('https://spool.example/assets/index-current.js'),
      {
        ASSETS: {
          fetch: vi.fn().mockResolvedValue(new Response(asset, {
            headers: { 'Content-Type': 'application/javascript' },
          })),
        },
      },
    );

    expect(response.headers.get('X-Spool-Asset-Recovery')).toBeNull();
    expect(response.headers.get('Content-Type')).toContain('application/javascript');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    await expect(response.text()).resolves.toBe(asset);
  });

  it('keeps an ordinary SPA route as HTML', async () => {
    const html = '<!doctype html><div id="root"></div>';
    const response = await serveSpaAsset(
      new Request('https://spool.example/clients/acme'),
      {
        ASSETS: {
          fetch: vi.fn().mockResolvedValue(new Response(html, {
            headers: { 'Content-Type': 'text/html' },
          })),
        },
      },
    );

    expect(response.headers.get('X-Spool-Asset-Recovery')).toBeNull();
    expect(response.headers.get('Content-Type')).toContain('text/html');
    await expect(response.text()).resolves.toBe(html);
  });

  it('turns an HTML fallback for a stale entry module into one-shot recovery JavaScript', async () => {
    const response = await serveSpaAsset(
      // This is the entry hash from production immediately before PR #100.
      // Keeping the real incident URL here prevents the regression test from
      // drifting away from the failure the installed iPhone shell encountered.
      new Request('https://spool.example/assets/index-DadP79P7.js'),
      {
        ASSETS: {
          fetch: vi.fn().mockResolvedValue(new Response('<!doctype html>old fallback', {
            headers: { 'Content-Type': 'text/html' },
          })),
        },
      },
    );
    const script = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/javascript');
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(response.headers.get('X-Spool-Asset-Recovery')).toBe('1');
    expect(script).toBe(staleAssetRecoveryScript());
    expect(script).toContain("url.searchParams.has(marker)");
    expect(script).toContain('showFallback();return;');
    expect(script).not.toContain('spool.example/assets/index-DadP79P7.js');
  });

  it('turns an HTML fallback for a stale stylesheet into safe empty CSS', async () => {
    const response = await serveSpaAsset(
      new Request('https://spool.example/assets/index-DrwGBARD.css'),
      {
        ASSETS: {
          fetch: vi.fn().mockResolvedValue(new Response('<!doctype html>old fallback', {
            headers: { 'Content-Type': 'text/html' },
          })),
        },
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/css');
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(response.headers.get('X-Spool-Asset-Recovery')).toBe('style');
    expect(await response.text()).not.toContain('<!doctype html>');
  });

  it('returns an honest 404 for another missing asset instead of SPA HTML', async () => {
    const response = await serveSpaAsset(
      new Request('https://spool.example/assets/deleted-image.png'),
      {
        ASSETS: {
          fetch: vi.fn().mockResolvedValue(new Response('<!doctype html>old fallback', {
            headers: { 'Content-Type': 'text/html' },
          })),
        },
      },
    );

    expect(response.status).toBe(404);
    expect(response.headers.get('Content-Type')).toContain('text/plain');
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    await expect(response.text()).resolves.toBe('Not found');
  });

  it('keeps symbolic error codes separate from human-safe messages', () => {
    for (const code of [
      'review_conflict',
      'review_baseline_required',
      'mixed_review_edit',
      'feedback_invalid',
      'feedback_thread_full',
      'feedback_thread_invalid',
      'draft_cursor_invalid',
    ]) {
      expect(symbolicErrorPayload(code, 'Safe message')).toEqual({ error: code, message: 'Safe message' });
    }
  });

  it('measures the exact final draft envelope rather than only its row array', () => {
    const body = draftListResponseBody({
      drafts: [{ id: 'A'.repeat(20), content: 'x'.repeat(1024) }],
      total: 2,
      truncated: true,
    }, 'opaque-cursor');
    expect(serializedJsonBytes(body)).toBe(new TextEncoder().encode(JSON.stringify(body)).byteLength);
    expect(body).toEqual(expect.objectContaining({
      count: 1, total: 2, truncated: true, nextCursor: 'opaque-cursor',
    }));
  });

  it('advertises every implemented method on a hardened CORS preflight', async () => {
    const response = await worker.fetch(new Request('https://spool.example/api/drafts', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://pom.stitchtec.dev',
        'Access-Control-Request-Method': 'PATCH',
      },
    }), {
      ALLOWED_ORIGINS: 'https://pom.stitchtec.dev',
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://pom.stitchtec.dev');
    expect(response.headers.get('Access-Control-Allow-Methods'))
      .toBe('GET,POST,PATCH,DELETE,HEAD,OPTIONS');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it.each([
    ['a dependency', 'https://spool.example/media/v2/generated/o/x.png', {
      ALLOWED_ORIGINS: 'https://pom.stitchtec.dev',
      MEDIA: { get: vi.fn().mockRejectedValue(new Error('R2 unavailable')) },
    }],
    ['the asset binding', 'https://spool.example/app-route', {
      ALLOWED_ORIGINS: 'https://pom.stitchtec.dev',
      ASSETS: { fetch: vi.fn().mockRejectedValue(new Error('assets unavailable')) },
    }],
  ])('returns a hardened generic 500 when %s throws', async (_label, url, env) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await worker.fetch(new Request(url, {
      headers: { Origin: 'https://pom.stitchtec.dev' },
    }), env);

    expect(response.status).toBe(500);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://pom.stitchtec.dev');
    expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    await expect(response.json()).resolves.toEqual({ error: 'Internal server error' });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('draft image size mapping', () => {
  it('returns 413 before decoding or writing an oversized base64 draft image', async () => {
    const oversized = 'A'.repeat(Math.ceil((MAX_IMAGE_BYTES + 1) / 3) * 4);
    const response = await worker.fetch(new Request('https://spool.example/api/drafts', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer internal-test-key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client: 'Acme',
        clientId: 'acme',
        platform: 'gmb',
        content: 'Draft copy',
        image: { base64: oversized, mime: 'image/png' },
      }),
    }), {
      ALLOWED_ORIGINS: '*',
      INTERNAL_API_KEY: 'internal-test-key',
      OWNER_UID: 'owner',
      MEDIA: { head: vi.fn(), put: vi.fn() },
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: 'Image exceeds the 5 MB limit' });
  });

  it('rejects an oversized declared JSON envelope before parsing it', async () => {
    const response = await worker.fetch(new Request('https://spool.example/api/drafts', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer internal-test-key',
        'Content-Type': 'application/json',
        'Content-Length': '7000000',
      },
      body: '{}',
    }), {
      ALLOWED_ORIGINS: '*',
      INTERNAL_API_KEY: 'internal-test-key',
      OWNER_UID: 'owner',
    });
    expect(response.status).toBe(413);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    await expect(response.json()).resolves.toEqual({ error: 'Request body is too large' });
  });
});

describe('draft document route boundaries', () => {
  it('rejects encoded collection traversal for GET/PATCH/DELETE before Firestore access', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const env = {
      ALLOWED_ORIGINS: '*',
      INTERNAL_API_KEY: 'internal-test-key',
      OWNER_UID: 'owner',
    };
    const path = '/api/drafts/%2E%2E%2Fusers%2Fvictim';
    for (const method of ['GET', 'PATCH', 'DELETE']) {
      const response = await worker.fetch(new Request(`https://spool.example${path}`, {
        method,
        headers: {
          Authorization: 'Bearer internal-test-key',
          ...(method === 'PATCH' ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(method === 'PATCH' ? { body: JSON.stringify({ title: 'x' }) } : {}),
      }), env);
      expect(response.status).toBe(400);
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      await expect(response.json()).resolves.toEqual({ error: 'Invalid draft id' });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('fails malformed automation and share decoding closed', () => {
    expect(() => decodeAutoId('%', 'automation')).toThrow(/Malformed automation id/);
    expect(() => decodeShareToken('%')).toThrow(/Malformed share token/);
    expect(() => decodeAutoId('%2E%2E%2Fposts%2Fvictim', 'automation'))
      .toThrow(/Invalid automation id/);
  });

  it('returns a hardened 400 for malformed draft encoding', async () => {
    const response = await worker.fetch(new Request('https://spool.example/api/drafts/%', {
      headers: { Authorization: 'Bearer internal-test-key' },
    }), {
      ALLOWED_ORIGINS: '*',
      INTERNAL_API_KEY: 'internal-test-key',
      OWNER_UID: 'owner',
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    await expect(response.json()).resolves.toEqual({ error: 'Invalid draft id' });
  });
});

describe('draft list pagination boundaries', () => {
  it.each([
    ['limit=0', /limit/],
    ['limit=1001', /limit/],
    ['limit=12oops', /limit/],
    ['platform=myspace', /Unknown platform/],
    ['status=deleted', /Unknown status/],
    ['reviewStage=missing', /Unknown reviewStage/],
    ['clientId=Acme!', /canonical client slug/],
    ['cursor=%25', /cursor/],
  ])('rejects %s before any Firestore allocation', async (query, errorPattern) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const response = await worker.fetch(new Request(`https://spool.example/api/drafts?${query}`, {
      headers: { Authorization: 'Bearer internal-test-key' },
    }), {
      ALLOWED_ORIGINS: '*',
      INTERNAL_API_KEY: 'internal-test-key',
      OWNER_UID: 'owner',
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const payload = await response.json();
    if (query.startsWith('cursor=')) {
      expect(payload).toEqual({
        error: 'draft_cursor_invalid',
        message: expect.stringMatching(errorPattern),
      });
    } else {
      expect(payload).toEqual({ error: expect.stringMatching(errorPattern) });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
