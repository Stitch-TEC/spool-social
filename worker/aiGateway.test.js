import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  exposedGenerationError,
  generateImage,
  generateText,
  GenerationUnavailableError,
} from './aiGateway.js';

const gatewayEnv = (response) => ({
  AI: { fetch: vi.fn().mockResolvedValue(response) },
  STITCH_AI_KEY: 'spool-key',
  SPOOL_AI_TIER: 'standard',
  // A legacy provider key must have no effect even when it still exists on a
  // deployed Worker during source rollout.
  GEMINI_API_KEY: 'must-never-be-used',
});

afterEach(() => vi.restoreAllMocks());

describe('Spool AI gateway boundary', () => {
  it('keeps direct provider endpoints and credentials out of Worker runtime source', () => {
    const workerDir = dirname(fileURLToPath(import.meta.url));
    const runtimeSource = readdirSync(workerDir)
      .filter((name) => name.endsWith('.js') && !name.endsWith('.test.js'))
      .map((name) => readFileSync(join(workerDir, name), 'utf8'))
      .join('\n');

    expect(runtimeSource).not.toMatch(/generativelanguage\.googleapis\.com/);
    expect(runtimeSource).not.toMatch(/env\.GEMINI_API_KEY/);
    expect(runtimeSource).not.toMatch(/x-goog-api-key/i);
  });

  it('sends text only through the service binding with client attribution', async () => {
    const directFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('direct fetch forbidden'));
    const env = gatewayEnv(new Response(JSON.stringify({ ok: true, text: 'Gateway copy' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(generateText(env, 'Draft this', {
      system: 'Stay concise',
      maxTokens: 240,
      clientId: 'acme',
    })).resolves.toBe('Gateway copy');

    expect(env.AI.fetch).toHaveBeenCalledOnce();
    const [url, init] = env.AI.fetch.mock.calls[0];
    expect(url).toBe('https://ai-worker.internal/generate');
    expect(init.headers.authorization).toBe('Bearer spool-key');
    expect(JSON.parse(init.body)).toEqual({
      task: 'spool-copy',
      tier: 'standard',
      system: 'Stay concise',
      prompt: 'Draft this',
      maxTokens: 240,
      clientId: 'acme',
    });
    expect(directFetch).not.toHaveBeenCalled();
  });

  it('fails safely when the gateway binding or app key is missing', async () => {
    const directFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('direct fetch forbidden'));

    await expect(generateText({ GEMINI_API_KEY: 'legacy-key' }, 'Draft this'))
      .rejects.toMatchObject({
        code: 'ai_gateway_not_configured',
        status: 503,
        exposeToClient: true,
      });
    await expect(generateImage({ AI: { fetch: vi.fn() }, GEMINI_API_KEY: 'legacy-key' }, 'Hero'))
      .rejects.toMatchObject({ code: 'ai_gateway_not_configured' });
    expect(directFetch).not.toHaveBeenCalled();
  });

  it('does not bypass the gateway after an upstream failure', async () => {
    const directFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('direct fetch forbidden'));
    const env = gatewayEnv(new Response(JSON.stringify({ error: 'provider_not_configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(generateText(env, 'Draft this')).rejects.toMatchObject({
      code: 'ai_gateway_unavailable',
      status: 503,
    });
    expect(env.AI.fetch).toHaveBeenCalledOnce();
    expect(directFetch).not.toHaveBeenCalled();
  });

  it('preserves quota denials as policy outcomes', async () => {
    const env = gatewayEnv(new Response(JSON.stringify({
      error: 'quota_exceeded',
      used: 1200,
      quota: 1000,
    }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    }));

    const err = await generateText(env, 'Draft this').catch((caught) => caught);
    expect(err).toMatchObject({
      code: 'quota_exceeded',
      status: 429,
      quotaExceeded: true,
      retryable: false,
    });
    expect(exposedGenerationError(err)).toEqual({
      status: 429,
      body: {
        error: err.message,
        code: 'quota_exceeded',
        retryable: false,
      },
    });
  });

  it('truthfully disables image-input text until the gateway supports it', async () => {
    const directFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('direct fetch forbidden'));
    const env = gatewayEnv(new Response('{}'));

    const err = await generateText(env, 'Describe this', {
      image: { data: 'aGVsbG8=', mimeType: 'image/png' },
      clientId: 'acme',
    }).catch((caught) => caught);

    expect(err).toBeInstanceOf(GenerationUnavailableError);
    expect(err).toMatchObject({
      code: 'multimodal_unavailable',
      status: 503,
      retryable: false,
      exposeToClient: true,
    });
    expect(err.message).toContain('add alt text manually');
    expect(env.AI.fetch).not.toHaveBeenCalled();
    expect(directFetch).not.toHaveBeenCalled();
  });

  it('sends image generation only through the gateway image endpoint', async () => {
    const directFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('direct fetch forbidden'));
    const env = gatewayEnv(new Response(JSON.stringify({
      ok: true,
      b64: 'iVBORw0KGgo=',
      mime: 'image/png',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(generateImage(env, 'A clean hero', { clientId: 'acme' }))
      .resolves.toEqual({ b64: 'iVBORw0KGgo=', mime: 'image/png' });
    const [url, init] = env.AI.fetch.mock.calls[0];
    expect(url).toBe('https://ai-worker.internal/image');
    expect(JSON.parse(init.body)).toEqual({
      task: 'spool-image',
      prompt: 'A clean hero',
      clientId: 'acme',
    });
    expect(directFetch).not.toHaveBeenCalled();
  });

  it('preserves image-generation quota denials without a fallback', async () => {
    const directFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('direct fetch forbidden'));
    const env = gatewayEnv(new Response(JSON.stringify({
      error: 'quota_exceeded',
      used: 3000,
      quota: 2500,
    }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(generateImage(env, 'A clean hero', { clientId: 'acme' }))
      .rejects.toMatchObject({
        code: 'quota_exceeded',
        status: 429,
        quotaExceeded: true,
        retryable: false,
      });
    expect(env.AI.fetch).toHaveBeenCalledOnce();
    expect(directFetch).not.toHaveBeenCalled();
  });

  it('does not bypass the gateway when image generation fails', async () => {
    const directFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('direct fetch forbidden'));
    const env = gatewayEnv(new Response(JSON.stringify({ error: 'upstream_failed' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(generateImage(env, 'A clean hero')).rejects.toMatchObject({
      code: 'ai_gateway_unavailable',
      status: 503,
    });
    expect(env.AI.fetch).toHaveBeenCalledOnce();
    expect(directFetch).not.toHaveBeenCalled();
  });

  it('exposes only known safe availability errors', () => {
    const safe = new GenerationUnavailableError(
      'ai_gateway_unavailable',
      'AI is temporarily unavailable. Your draft is safe — try again shortly.',
    );
    expect(exposedGenerationError(safe)).toEqual({
      status: 503,
      body: {
        error: safe.message,
        code: 'ai_gateway_unavailable',
        retryable: true,
      },
    });
    expect(exposedGenerationError(new Error('provider leaked a secret'))).toBeNull();
  });
});
