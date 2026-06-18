import { describe, it, expect } from 'vitest';
import { buildTextContext } from './aiPrompt';

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
