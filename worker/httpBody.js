export const DEFAULT_JSON_BYTES = 256_000;
// Five decoded MB expands to at most 6,666,668 base64 characters. Leave a
// bounded envelope for JSON keys plus draft copy/metadata, but never accept an
// unbounded request merely because Content-Length is absent.
export const IMAGE_JSON_BYTES = 6_900_000;
export const MULTIMODAL_JSON_BYTES = 11_200_000;

export class BodyTooLargeError extends Error {
  constructor(message = 'Request body is too large') {
    super(message);
    this.name = 'BodyTooLargeError';
    this.code = 'body_too_large';
    this.status = 413;
  }
}

function declaredLength(headers) {
  const raw = headers?.get?.('Content-Length');
  if (raw == null || raw === '') return null;
  if (!/^[0-9]+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : Infinity;
}

/** Read a request/response body into a bounded Uint8Array.
 *
 * The declared length is rejected before touching the stream. When it is
 * absent or dishonest, the streaming counter cancels as soon as the cap is
 * crossed, before allocating one combined output buffer.
 */
export async function readBytesBounded(body, headers, maxBytes) {
  const declared = declaredLength(headers);
  if (declared !== null && declared > maxBytes) throw new BodyTooLargeError();
  if (!body) return new Uint8Array();

  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value || 0);
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel('body_too_large').catch(() => {});
        throw new BodyTooLargeError();
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function readJsonBounded(request, maxBytes = DEFAULT_JSON_BYTES) {
  const bytes = await readBytesBounded(request.body, request.headers, maxBytes);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    const err = new Error('Invalid JSON');
    err.code = 'invalid_json';
    err.status = 400;
    throw err;
  }
}
