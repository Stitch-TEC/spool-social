// Builds Gemini inputs from the editor's context — target platform, chosen
// tone/length/style, and the selected client's saved AI settings. Keeping these
// pure makes them testable and keeps the Worker a thin, generic generation API.

import {
  PLATFORMS,
  PLATFORM_AI_GUIDANCE,
  TONE_PRESETS,
  LENGTH_PRESETS,
  IMAGE_STYLE_PRESETS,
  PLATFORM_IMAGE_ASPECT
} from '../constants';

const BASE_VOICE_SOCIAL =
  'You are an expert social media copywriter. Return only the final, ready-to-post copy — ' +
  'no preamble, no multiple options, no explanations, and no surrounding quotes.';

const BASE_VOICE_LONGFORM =
  'You are an expert long-form content writer. Write the post body in Markdown. Return only the ' +
  'finished article — no preamble, no meta commentary, and no surrounding code fences.';

const DEFAULT_MAX_TOKENS = 600;
const LONGFORM_MAX_TOKENS = { short: 800, medium: 2000, long: 4000 };
const LONGFORM_LENGTH_HINT = {
  short: 'Aim for roughly 300–400 words.',
  medium: 'Aim for roughly 700–900 words.',
  long: 'Aim for 1200+ words across multiple sections.'
};

// Collapse whitespace/newlines so owner-supplied free text can't inject extra
// lines into the (newline-delimited) system instruction.
const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();

// System instruction + token budget for a text generation.
export function buildTextContext({ platform, tone, length, clientName, clientSettings } = {}) {
  const p = PLATFORMS[platform] || PLATFORMS.gmb;
  const guidance = PLATFORM_AI_GUIDANCE[p.id] || PLATFORM_AI_GUIDANCE.gmb;
  const toneDef = TONE_PRESETS.find(t => t.id === tone);
  const lengthDef = LENGTH_PRESETS.find(l => l.id === length);
  const c = clientSettings || {};
  const longForm = !!p.longForm;

  const lines = [
    longForm ? BASE_VOICE_LONGFORM : BASE_VOICE_SOCIAL,
    `Write ${guidance}`
  ];
  if (!longForm) lines.push(`Hard limit: keep the post under ${p.maxChars} characters.`);
  if (toneDef) lines.push(`Tone: ${toneDef.instruction}.`);
  if (longForm) {
    lines.push(LONGFORM_LENGTH_HINT[length] || LONGFORM_LENGTH_HINT.medium);
  } else if (lengthDef) {
    lines.push(lengthDef.instruction);
  }
  if (clientName) lines.push(`This is for the brand "${clean(clientName)}".`);
  if (c.aiBrandVoice) lines.push(`Brand voice: ${clean(c.aiBrandVoice)}`);
  if (c.aiAudience) lines.push(`Target audience: ${clean(c.aiAudience)}`);
  if (c.aiKeywords) lines.push(`Where natural, work in these themes/keywords: ${clean(c.aiKeywords)}`);
  if (c.aiAvoid) lines.push(`Avoid the following: ${clean(c.aiAvoid)}`);

  const maxTokens = longForm
    ? (LONGFORM_MAX_TOKENS[length] || LONGFORM_MAX_TOKENS.medium)
    : (lengthDef?.maxTokens || DEFAULT_MAX_TOKENS);

  return { system: lines.join('\n'), maxTokens };
}

// A single composed prompt string for an image generation.
export function buildImagePrompt({ prompt, style, platform, clientName, clientSettings } = {}) {
  const styleDef = IMAGE_STYLE_PRESETS.find(s => s.id === style);
  const aspect = PLATFORM_IMAGE_ASPECT[platform] || PLATFORM_IMAGE_ASPECT.gmb;
  const c = clientSettings || {};

  const parts = [];
  if (styleDef) parts.push(`${styleDef.instruction} of:`);
  parts.push(clean(prompt));
  parts.push(`Composition: ${aspect}.`);
  if (clientName) parts.push(`For the brand "${clean(clientName)}".`);
  if (c.brandColor) parts.push(`Subtly incorporate the brand color ${c.brandColor} where appropriate.`);
  if (c.aiKeywords) parts.push(`Visual mood/subject to evoke: ${clean(c.aiKeywords)}.`);

  return parts.filter(Boolean).join(' ');
}
