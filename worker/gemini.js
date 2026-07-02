// Thin wrapper around the Gemini generateContent API.
// The same endpoint shape serves both text and image models, so one API key
// covers both /api/text and /api/generate.

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

async function callGemini(env, model, body) {
  // Auth via the x-goog-api-key header (works for both legacy AIza... keys and
  // the newer AQ.... keys; keeps the key out of the request URL/logs).
  const res = await fetch(`${BASE}/${model}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': env.GEMINI_API_KEY
    },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || `Gemini error ${res.status}`);
  }
  return data;
}

// Primary text path: the shared AI gateway (ai-worker) over the Service Binding.
// Text-only prompts only — multimodal (opts.image) stays on direct Gemini until
// the gateway supports image input. Throws on any failure so generateText can
// fall through to the direct-Gemini path (resident fallback during cutover).
async function generateTextViaGateway(env, prompt, opts = {}) {
  const res = await env.AI.fetch('https://ai-worker.internal/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${env.STITCH_AI_KEY}` },
    body: JSON.stringify({
      task: 'spool-copy',
      tier: env.SPOOL_AI_TIER || 'cheap', // bump to "standard" for higher-quality copy
      system: opts.system || undefined,
      prompt,
      maxTokens: opts.maxTokens || parseInt(env.MAX_OUTPUT_TOKENS || '1024', 10),
      // Per-client usage metering (control-plane Phase 3) — contextual, not auth; the gateway
      // meters under 'unattributed' when absent.
      clientId: opts.clientId || undefined
    }),
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`ai gateway ${res.status}`);
  const data = await res.json().catch(() => ({}));
  if (!data.ok || !data.text) throw new Error('ai gateway returned no text');
  return data.text;
}

export async function generateText(env, prompt, opts = {}) {
  // Prefer the shared AI gateway for text-only prompts; multimodal stays on Gemini.
  // ANY gateway failure falls through to the direct-Gemini path below.
  if (env.AI && env.STITCH_AI_KEY && !opts.image) {
    try {
      return await generateTextViaGateway(env, prompt, opts);
    } catch {
      // fall through to direct Gemini (resident fallback during cutover)
    }
  }

  const model = env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash';

  const promptParts = [{ text: prompt }];
  // Optional image for multimodal prompts (e.g. alt-text from the actual image).
  if (opts.image?.data) {
    promptParts.push({ inlineData: { mimeType: opts.image.mimeType || 'image/png', data: opts.image.data } });
  }
  const body = { contents: [{ parts: promptParts }] };

  // Optional system instruction sets voice/format/constraints (see aiPrompt.js).
  if (opts.system) {
    body.systemInstruction = { parts: [{ text: opts.system }] };
  }

  // Cap output length (cost control) + optional temperature.
  const generationConfig = {};
  const maxTokens = opts.maxTokens || parseInt(env.MAX_OUTPUT_TOKENS || '1024', 10);
  if (maxTokens > 0) generationConfig.maxOutputTokens = maxTokens;
  if (typeof opts.temperature === 'number') generationConfig.temperature = opts.temperature;

  // gemini-2.5 models "think" by default, and thinking tokens count against
  // maxOutputTokens — a low cap can be consumed entirely by thinking, yielding
  // truncated/empty copy. Disable thinking for copywriting (also faster/cheaper).
  // Override via GEMINI_THINKING_BUDGET if a future model needs it.
  const rawThinking = (env.GEMINI_THINKING_BUDGET ?? '').trim();
  const thinkingBudget = rawThinking === '' ? 0 : parseInt(rawThinking, 10);
  if (Number.isFinite(thinkingBudget)) {
    generationConfig.thinkingConfig = { thinkingBudget };
  }

  body.generationConfig = generationConfig;

  const data = await callGemini(env, model, body);
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map(p => p.text).filter(Boolean).join('\n').trim();
  if (!text) throw new Error('No text returned');
  return text;
}

export async function generateImage(env, prompt, opts = {}) {
  // Prefer the shared AI gateway (ai-worker /image); ANY failure falls through to
  // the direct-Gemini path below (resident fallback during cutover).
  if (env.AI && env.STITCH_AI_KEY) {
    try {
      const res = await env.AI.fetch('https://ai-worker.internal/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: `Bearer ${env.STITCH_AI_KEY}` },
        // clientId = per-client usage metering (Phase 3); contextual, 'unattributed' when absent.
        body: JSON.stringify({ task: 'spool-image', prompt, clientId: opts.clientId || undefined }),
        signal: AbortSignal.timeout(60000) // image gen is slower than text
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.ok && data.b64) return { b64: data.b64, mime: data.mime || 'image/png' };
      }
    } catch {
      // fall through to direct Gemini
    }
  }

  const model = env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
  // NOTE: responseModalities casing/values can vary by model generation. If a
  // model rejects this, check its current docs (some want ['TEXT','IMAGE']).
  const data = await callGemini(env, model, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['IMAGE'] }
  });
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const img = parts.find(p => p.inlineData?.data);
  if (!img) throw new Error('No image returned');
  return { b64: img.inlineData.data, mime: img.inlineData.mimeType || 'image/png' };
}
