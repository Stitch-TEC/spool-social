// Spool's only model-inference client.
//
// Provider credentials and provider/model routing belong to ai-worker. Spool
// presents only its per-app STITCH_AI_KEY over the Cloudflare Service Binding.
// A gateway failure disables the optional AI action without affecting the
// surrounding draft workflow; it must never fall through to a direct provider.

const TEXT_TIMEOUT_MS = 20000;
const IMAGE_TIMEOUT_MS = 60000;

const UNAVAILABLE_MESSAGE =
  'AI is temporarily unavailable. Your draft is safe — try again shortly.';
const MULTIMODAL_UNAVAILABLE_MESSAGE =
  'Automatic alt text is temporarily unavailable. Your draft is safe — add alt text manually or try again later.';

export class GenerationUnavailableError extends Error {
  constructor(code, message, { retryable = true, internalReason = '' } = {}) {
    super(message);
    this.name = 'GenerationUnavailableError';
    this.code = code;
    this.status = 503;
    this.retryable = retryable;
    this.exposeToClient = true;
    this.internalReason = internalReason;
  }
}

function gatewayBinding(env) {
  if (!env?.AI || typeof env.AI.fetch !== 'function' || !env.STITCH_AI_KEY) {
    throw new GenerationUnavailableError(
      'ai_gateway_not_configured',
      UNAVAILABLE_MESSAGE,
      { internalReason: 'AI service binding or STITCH_AI_KEY is missing' },
    );
  }
  return env.AI;
}

function quotaError(data) {
  const err = new Error(
    `This client's monthly AI budget is used up (${(data.used ?? 0).toLocaleString()} of ${(data.quota ?? 0).toLocaleString()} tokens). Raise the AI quota in POM to continue.`,
  );
  err.code = 'quota_exceeded';
  err.status = 429;
  err.retryable = false;
  err.quotaExceeded = true;
  err.exposeToClient = true;
  return err;
}

async function gatewayFailure(res, operation) {
  const data = await res.json().catch(() => ({}));
  if (res.status === 429 && data.error === 'quota_exceeded') throw quotaError(data);
  throw new GenerationUnavailableError(
    'ai_gateway_unavailable',
    UNAVAILABLE_MESSAGE,
    { internalReason: `${operation} returned HTTP ${res.status}` },
  );
}

function timeoutSignal(ms) {
  return AbortSignal.timeout(ms);
}

function gatewayRequestError(err, operation) {
  if (err?.quotaExceeded || err instanceof GenerationUnavailableError) return err;
  const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
  return new GenerationUnavailableError(
    'ai_gateway_unavailable',
    UNAVAILABLE_MESSAGE,
    { internalReason: timedOut ? `${operation} timed out` : `${operation} request failed` },
  );
}

export async function generateText(env, prompt, opts = {}) {
  // /generate's current additive contract accepts string message content only.
  // Never strip the image and pretend an alt-text result is grounded; disable
  // this optional helper until ai-worker accepts normalized image content.
  if (opts.image) {
    throw new GenerationUnavailableError(
      'multimodal_unavailable',
      MULTIMODAL_UNAVAILABLE_MESSAGE,
      { retryable: false, internalReason: 'ai-worker /generate does not accept image content' },
    );
  }

  const binding = gatewayBinding(env);
  let res;
  try {
    res = await binding.fetch('https://ai-worker.internal/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${env.STITCH_AI_KEY}`,
      },
      body: JSON.stringify({
        task: 'spool-copy',
        tier: env.SPOOL_AI_TIER || 'cheap',
        system: opts.system || undefined,
        prompt,
        maxTokens: opts.maxTokens || parseInt(env.MAX_OUTPUT_TOKENS || '1024', 10),
        // Contextual metering attribution, never authorization. ai-worker uses
        // its explicit 'unattributed' bucket when no client slug is available.
        clientId: opts.clientId || undefined,
      }),
      signal: timeoutSignal(TEXT_TIMEOUT_MS),
    });
  } catch (err) {
    throw gatewayRequestError(err, 'text generation');
  }

  if (!res.ok) await gatewayFailure(res, 'text generation');
  const data = await res.json().catch(() => ({}));
  if (!data.ok || !data.text) {
    throw new GenerationUnavailableError(
      'ai_gateway_invalid_response',
      UNAVAILABLE_MESSAGE,
      { internalReason: 'text generation returned no text' },
    );
  }
  return data.text;
}

export async function generateImage(env, prompt, opts = {}) {
  const binding = gatewayBinding(env);
  let res;
  try {
    res = await binding.fetch('https://ai-worker.internal/image', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${env.STITCH_AI_KEY}`,
      },
      body: JSON.stringify({
        task: 'spool-image',
        prompt,
        clientId: opts.clientId || undefined,
      }),
      signal: timeoutSignal(IMAGE_TIMEOUT_MS),
    });
  } catch (err) {
    throw gatewayRequestError(err, 'image generation');
  }

  if (!res.ok) await gatewayFailure(res, 'image generation');
  const data = await res.json().catch(() => ({}));
  if (!data.ok || !data.b64) {
    throw new GenerationUnavailableError(
      'ai_gateway_invalid_response',
      UNAVAILABLE_MESSAGE,
      { internalReason: 'image generation returned no image' },
    );
  }
  return { b64: data.b64, mime: data.mime || 'image/png' };
}

export function exposedGenerationError(err) {
  if (!err?.exposeToClient) return null;
  return {
    status: err.status || 503,
    body: {
      error: err.message,
      code: err.code || 'ai_gateway_unavailable',
      retryable: err.retryable !== false,
    },
  };
}
