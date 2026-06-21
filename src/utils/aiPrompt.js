// The prompt builders now live in the pure, dependency-free src/generation
// module so the Cloudflare Worker can reuse them without bundling React/lucide
// (src/constants.js imports lucide). This file re-exports them so existing
// callers (and tests) keep importing from '../utils/aiPrompt' unchanged.

export { buildTextContext, buildImagePrompt } from '../generation/prompts';
