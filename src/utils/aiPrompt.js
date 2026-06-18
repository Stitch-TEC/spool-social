// Builds the Gemini system instruction + token budget for a text generation
// from the editor's context: the target platform, the chosen tone/length, and
// the selected client's saved AI settings. Keeping this pure makes it testable
// and keeps the Worker a thin, generic generation endpoint.

import { PLATFORMS, PLATFORM_AI_GUIDANCE, TONE_PRESETS, LENGTH_PRESETS } from '../constants';

const BASE_VOICE =
  'You are an expert social media copywriter. Return only the final, ready-to-post copy — ' +
  'no preamble, no multiple options, no explanations, and no surrounding quotes.';

const DEFAULT_MAX_TOKENS = 600;

export function buildTextContext({ platform, tone, length, clientName, clientSettings } = {}) {
  const p = PLATFORMS[platform] || PLATFORMS.gmb;
  const guidance = PLATFORM_AI_GUIDANCE[p.id] || PLATFORM_AI_GUIDANCE.gmb;
  const toneDef = TONE_PRESETS.find(t => t.id === tone);
  const lengthDef = LENGTH_PRESETS.find(l => l.id === length);
  const c = clientSettings || {};

  const lines = [
    BASE_VOICE,
    `Write ${guidance}`,
    `Hard limit: keep the post under ${p.maxChars} characters.`
  ];
  if (toneDef) lines.push(`Tone: ${toneDef.instruction}.`);
  if (lengthDef) lines.push(lengthDef.instruction);
  if (clientName) lines.push(`This is for the brand "${clientName}".`);
  if (c.aiBrandVoice) lines.push(`Brand voice: ${c.aiBrandVoice}`);
  if (c.aiAudience) lines.push(`Target audience: ${c.aiAudience}`);
  if (c.aiKeywords) lines.push(`Where natural, work in these themes/keywords: ${c.aiKeywords}`);
  if (c.aiAvoid) lines.push(`Avoid the following: ${c.aiAvoid}`);

  return {
    system: lines.join('\n'),
    maxTokens: lengthDef?.maxTokens || DEFAULT_MAX_TOKENS
  };
}
