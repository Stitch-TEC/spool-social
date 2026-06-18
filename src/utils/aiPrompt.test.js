import { describe, it, expect } from 'vitest';
import { buildTextContext, buildImagePrompt } from './aiPrompt';

describe('buildTextContext', () => {
  it('includes platform guidance and the char limit', () => {
    const { system } = buildTextContext({ platform: 'twitter' });
    expect(system).toMatch(/280 characters/);
    expect(system).toMatch(/X\/Twitter/);
  });

  it('falls back to gmb for an unknown platform', () => {
    const { system } = buildTextContext({ platform: 'nope' });
    expect(system).toMatch(/Google Business/);
  });

  it('weaves in tone, length budget, and client context', () => {
    const { system, maxTokens } = buildTextContext({
      platform: 'linkedin',
      tone: 'bold',
      length: 'short',
      clientName: 'Acme',
      clientSettings: {
        aiBrandVoice: 'no jargon',
        aiAudience: 'CFOs',
        aiKeywords: 'ROI',
        aiAvoid: 'emojis'
      }
    });
    expect(system).toMatch(/bold/);
    expect(system).toMatch(/Acme/);
    expect(system).toMatch(/no jargon/);
    expect(system).toMatch(/CFOs/);
    expect(system).toMatch(/ROI/);
    expect(system).toMatch(/emojis/);
    expect(maxTokens).toBe(160);
  });

  it('returns a positive default token budget when no length is given', () => {
    const { maxTokens } = buildTextContext({ platform: 'gmb' });
    expect(maxTokens).toBeGreaterThan(0);
  });
});

describe('buildImagePrompt', () => {
  it('composes style, prompt, platform aspect, and brand context', () => {
    const out = buildImagePrompt({
      prompt: 'a carbon-fiber panel',
      style: 'studio',
      platform: 'instagram',
      clientName: 'Acme',
      clientSettings: { brandColor: '#ff0000', aiKeywords: 'aerospace' }
    });
    expect(out).toMatch(/studio product/i);
    expect(out).toMatch(/carbon-fiber panel/);
    expect(out).toMatch(/square 1:1/);
    expect(out).toMatch(/Acme/);
    expect(out).toMatch(/#ff0000/);
    expect(out).toMatch(/aerospace/);
  });

  it('works with just a prompt and defaults the aspect ratio', () => {
    const out = buildImagePrompt({ prompt: 'a sunset' });
    expect(out).toMatch(/a sunset/);
    expect(out).toMatch(/landscape 4:3/);
  });
});
