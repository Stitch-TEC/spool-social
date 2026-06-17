// Thin wrapper around the Gemini generateContent API.
// The same endpoint shape serves both text and image models, so one API key
// covers both /api/text and /api/generate.

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

async function callGemini(env, model, body) {
  const res = await fetch(`${BASE}/${model}:generateContent?key=${env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || `Gemini error ${res.status}`);
  }
  return data;
}

export async function generateText(env, prompt) {
  const model = env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash';
  const data = await callGemini(env, model, {
    contents: [{ parts: [{ text: prompt }] }]
  });
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map(p => p.text).filter(Boolean).join('\n').trim();
  if (!text) throw new Error('No text returned');
  return text;
}

export async function generateImage(env, prompt) {
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
