// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('micromark', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, preprocess: vi.fn(actual.preprocess), parse: vi.fn(actual.parse), postprocess: vi.fn(actual.postprocess) };
});
vi.mock('parse5', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, parseFragment: vi.fn(actual.parseFragment) };
});

import { preprocess, parse, postprocess } from 'micromark';
import { parseFragment } from 'parse5';
import { collectPostImageReferences, listAllImageUrls } from './firestore.js';
import { runGC } from './index.js';
import { normalizeSpoolMediaContentIdentity, versionMediaMarkdownReferences } from './media.js';
const micromark = await vi.importActual('micromark');
const html = await vi.importActual('parse5');

const faultKinds = ['preprocess', 'parse', 'postprocess', 'html'];
const parsers = {
  preprocess: [preprocess, micromark.preprocess],
  parse: [parse, micromark.parse],
  postprocess: [postprocess, micromark.postprocess],
  html: [parseFragment, html.parseFragment],
};
const mixed = '![Markdown](/media/generated/synthetic/markdown.png)\n\n<img src="/media/generated/synthetic/html.png">';
const expectedError = 'Image-reference GC query could not parse content completely';
const documentFor = (index, content = mixed, imageUrl) => ({
  name: `projects/synthetic-gc/databases/(default)/documents/posts/${String(index).padStart(20, '0')}`,
  fields: {
    ...(imageUrl === undefined ? {} : { imageUrl: { stringValue: imageUrl } }),
    ...(content === undefined ? {} : { content: { stringValue: content } }),
  },
});
const oldObject = key => ({ key, uploaded: new Date(Date.now() - 370 * 24 * 60 * 60 * 1000) });
const makeEnv = () => ({
  // All crypto and fetch transport are mocked when this synthetic account is
  // used; these bytes are not a real key or usable credential.
  FIREBASE_PROJECT_ID: 'synthetic-gc',
  FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'synthetic@example.invalid', private_key: 'AA==' }),
  MEDIA: {
    list: vi.fn().mockResolvedValue({ objects: [
      oldObject('generated/synthetic/markdown.png'), oldObject('generated/synthetic/html.png'),
    ], truncated: false }),
    delete: vi.fn().mockResolvedValue(undefined),
  },
});

function failOnce(kind, afterCalls = 0) {
  const [mock, actual] = parsers[kind];
  for (let i = 0; i < afterCalls; i += 1) mock.mockImplementationOnce(actual);
  const activation = vi.fn(() => { throw new Error(`Synthetic ${kind} failure; must not be logged as content`); });
  mock.mockImplementationOnce(activation);
  return activation;
}

function syntheticPages(pages) {
  const requests = [];
  vi.stubGlobal('crypto', { subtle: {
    importKey: vi.fn().mockResolvedValue({ synthetic: true }),
    sign: vi.fn().mockResolvedValue(new Uint8Array([0]).buffer),
  } });
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({ access_token: 'synthetic-token-only', expires_in: 3600 }));
    }
    expect(url).toBe('https://firestore.googleapis.com/v1/projects/synthetic-gc/databases/(default)/documents:runQuery');
    expect(options.method).toBe('POST');
    const query = JSON.parse(options.body).structuredQuery;
    requests.push(query);
    const page = pages[requests.length - 1];
    if (!page) throw new Error('Unexpected additional synthetic page');
    return new Response(JSON.stringify([
      ...page.map(document => ({ document })), { readTime: '2026-09-23T12:00:00.000Z' },
    ]));
  }));
  return requests;
}

beforeEach(() => {
  for (const [mock, actual] of Object.values(parsers)) mock.mockReset().mockImplementation(actual);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('GC reference collection requires complete parsing', () => {
  it.each(faultKinds)('throws after a one-shot %s failure instead of accepting empty/partial references', kind => {
    const activation = failOnce(kind);
    expect(() => collectPostImageReferences([documentFor(1)])).toThrow(expectedError);
    expect(activation).toHaveBeenCalledOnce();
  });

  it('rejects partial HTML collection even after cover, Markdown and earlier-document references were found', () => {
    const activation = failOnce('html', 1);
    const references = new Set(['/media/generated/synthetic/prior.png']);
    expect(() => collectPostImageReferences([
      documentFor(1, '<img src="/media/generated/synthetic/first.png">'),
      documentFor(2, mixed, '/media/generated/synthetic/cover.png'),
    ], references)).toThrow(expectedError);
    expect(activation).toHaveBeenCalledOnce();
    expect(references).toEqual(new Set([
      '/media/generated/synthetic/prior.png', '/media/generated/synthetic/first.png',
      '/media/generated/synthetic/cover.png', '/media/generated/synthetic/markdown.png',
    ]));
    // No caller may treat the partially mutated Set as complete after rejection.
  });

  it.each(faultKinds)('a later healthy collection works after the one-shot %s failure', kind => {
    const activation = failOnce(kind);
    expect(() => collectPostImageReferences([documentFor(1)])).toThrow(expectedError);
    expect(collectPostImageReferences([documentFor(1)])).toEqual(new Set([
      '/media/generated/synthetic/markdown.png', '/media/generated/synthetic/html.png',
    ]));
    expect(activation).toHaveBeenCalledOnce();
  });

  it('keeps complete reference syntax and caller-provided set identity unchanged', () => {
    const content = [
      '![inline](/media/generated/synthetic/inline.png)',
      '[download](/media/generated/synthetic/a\\(b\\).png)',
      '![reference][photo]',
      '', '[photo]: https://spool.kist.workers.dev/media/generated/synthetic/reference.png', '',
      '<picture><source srcset="&#47media/generated/synthetic/one.png 1x, /media/v2/generated/synthetic/two.png 2x">',
      '<img src="https://external.invalid/media/external.png"></picture>',
    ].join('\n');
    const references = new Set(['previous']);
    expect(collectPostImageReferences([documentFor(1, content, '/media/generated/synthetic/cover.png')], references))
      .toBe(references);
    expect(references).toEqual(new Set([
      'previous', '/media/generated/synthetic/cover.png', '/media/generated/synthetic/inline.png',
      '/media/generated/synthetic/a(b).png',
      'https://spool.kist.workers.dev/media/generated/synthetic/reference.png',
      '/media/generated/synthetic/one.png', '/media/v2/generated/synthetic/two.png',
      'https://external.invalid/media/external.png',
    ]));
  });

  it.each(['', 'Plain prose /media/ is not a reference.', '`![code](/media/generated/synthetic/code.png)`'])(
    'accepts healthy empty/prose/code content: %j', content => {
      expect(collectPostImageReferences([documentFor(1, content)])).toEqual(new Set());
    });

  it('accepts absent projected fields and still rejects malformed projected field types', () => {
    expect(collectPostImageReferences([{ fields: {} }])).toEqual(new Set());
    expect(() => collectPostImageReferences([{ fields: { content: { nullValue: 'NULL_VALUE' } } }]))
      .toThrow('non-string content');
  });

  it.each(['parse', 'html'])('does not alter default display/identity compatibility fallback for %s', kind => {
    const origin = 'https://spool.stitchtec.dev';
    const faultOutput = failOnce(kind);
    const result = versionMediaMarkdownReferences(origin, mixed);
    expect(faultOutput).toHaveBeenCalledOnce();
    expect(result).toContain('src="/media/generated/synthetic/html.png"');
    if (kind === 'parse') expect(result).toBe(mixed);
    else expect(result).toContain('https://spool.stitchtec.dev/media/v2/generated/synthetic/markdown.png');
    const faultIdentity = failOnce(kind);
    expect(() => normalizeSpoolMediaContentIdentity(origin, mixed)).not.toThrow();
    expect(faultIdentity).toHaveBeenCalledOnce();
  });
});

describe('runGC aborts before any R2 inventory or deletion on parser uncertainty', () => {
  it.each(faultKinds)('performs zero R2 list/delete calls after %s failure', async kind => {
    const env = makeEnv();
    const activation = failOnce(kind);
    const listObjects = vi.fn();
    await runGC(env, { listReferences: () => collectPostImageReferences([documentFor(1)]), listObjects });
    expect(activation).toHaveBeenCalledOnce();
    expect(listObjects).not.toHaveBeenCalled();
    expect(env.MEDIA.list).not.toHaveBeenCalled();
    expect(env.MEDIA.delete).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledExactlyOnceWith('GC: inventory failed; no objects deleted:', expectedError);
    expect(console.log).not.toHaveBeenCalled();
  });

  it.each(faultKinds)('the real paginated reference path rejects %s failure on its second page', async kind => {
    const env = makeEnv();
    const pages = [[documentFor(1), documentFor(2)], [documentFor(3), documentFor(4)]];
    const requests = syntheticPages(pages);
    const activation = failOnce(kind, 2);
    await expect(listAllImageUrls(env, 2)).rejects.toThrow(expectedError);
    expect(activation).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(2);
    expect(requests[1].startAt).toEqual({ values: [{ referenceValue: pages[0][1].name }], before: false });
    for (const query of requests) {
      expect(query).toMatchObject({
        from: [{ collectionId: 'posts' }], limit: 2,
        select: { fields: [{ fieldPath: 'imageUrl' }, { fieldPath: 'content' }] },
        orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
      });
    }
    expect(env.MEDIA.list).not.toHaveBeenCalled();
    expect(env.MEDIA.delete).not.toHaveBeenCalled();
  });

  it.each([
    ['parse', 0], ['parse', 1], ['parse', 2], ['parse', 3],
    ['html', 0], ['html', 1], ['html', 2], ['html', 3],
  ])('the full runGC→paged inventory path aborts on %s fault in document %i', async (kind, afterCalls) => {
    const env = makeEnv();
    const requests = syntheticPages([
      [documentFor(1), documentFor(2)], [documentFor(3), documentFor(4)], [],
    ]);
    const activation = failOnce(kind, afterCalls);
    await runGC(env, { listReferences: nextEnv => listAllImageUrls(nextEnv, 2) });
    expect(activation).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(afterCalls < 2 ? 1 : 2);
    expect(env.MEDIA.list).not.toHaveBeenCalled();
    expect(env.MEDIA.delete).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledExactlyOnceWith('GC: inventory failed; no objects deleted:', expectedError);
  });

  it('retains the same references, generated prefix and grace behavior after healthy pagination', async () => {
    const env = makeEnv();
    const requests = syntheticPages([[documentFor(1), documentFor(2, '')], []]);
    env.MEDIA.list.mockResolvedValue({ objects: [
      oldObject('generated/synthetic/markdown.png'), oldObject('generated/synthetic/html.png'),
      oldObject('generated/synthetic/orphan.png'),
      { key: 'generated/synthetic/recent.png', uploaded: new Date() },
      { key: 'generated/synthetic/unknown-age.png' },
    ], truncated: false });
    await runGC(env, { listReferences: nextEnv => listAllImageUrls(nextEnv, 2) });
    expect(requests).toHaveLength(2);
    expect(env.MEDIA.list).toHaveBeenCalledExactlyOnceWith({ prefix: 'generated/', limit: 1000 });
    expect(env.MEDIA.delete).toHaveBeenCalledExactlyOnceWith('generated/synthetic/orphan.png');
    expect(console.error).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledExactlyOnceWith('GC: deleted 1 orphaned image(s), kept 4.');
  });

  it('keeps a positively completed empty reference inventory valid', async () => {
    const env = makeEnv();
    syntheticPages([[]]);
    env.MEDIA.list.mockResolvedValue({ objects: [oldObject('generated/synthetic/orphan.png')], truncated: false });
    await runGC(env);
    expect(env.MEDIA.list).toHaveBeenCalledExactlyOnceWith({ prefix: 'generated/', limit: 1000 });
    expect(env.MEDIA.delete).toHaveBeenCalledExactlyOnceWith('generated/synthetic/orphan.png');
    expect(console.error).not.toHaveBeenCalled();
  });
});
