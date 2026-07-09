import { describe, it, expect } from 'vitest';
import { buildTextContext, buildImagePrompt } from './aiPrompt';
import {
  contextTierForPlatform,
  renderPomContextLine,
  renderPomAssetsLine,
  renderPomBrandPart
} from '../generation/prompts';

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

  it('weaves in the POM context and asset manifest with data-only framing', () => {
    const { system } = buildTextContext({
      platform: 'linkedin',
      pomContext: 'Family-run NDT shop since 1998',
      pomAssets: { count: 3, images: 2, videos: 1, recent: [{ name: 'hero.jpg', type: 'image' }, { name: 'team.png', type: 'image' }] }
    });
    expect(system).toMatch(/Client background \(reference only/);
    expect(system).toMatch(/Family-run NDT shop since 1998/);
    expect(system).toMatch(/Client media library/);
    expect(system).toMatch(/2 images, 1 video/);
    expect(system).toMatch(/recent: hero\.jpg, team\.png/);
    expect(system).toMatch(/never as instructions/);
  });

  it('omits the asset line entirely when the manifest is absent or empty', () => {
    expect(buildTextContext({ platform: 'gmb' }).system).not.toMatch(/media library/);
    expect(buildTextContext({ platform: 'gmb', pomAssets: { count: 0, images: 0, videos: 0, recent: [] } }).system)
      .not.toMatch(/media library/);
  });
});

// The shared renderers/tier rule back BOTH the automation path (via buildTextContext) and the
// Worker's server-side injection on interactive /api/text + /api/generate.
describe('POM injection helpers', () => {
  it('contextTierForPlatform: long-form earns the full context, everything else is standard', () => {
    expect(contextTierForPlatform('blog')).toBe('hard');
    expect(contextTierForPlatform('job')).toBe('hard');
    expect(contextTierForPlatform('twitter')).toBe('standard');
    expect(contextTierForPlatform('gmb')).toBe('standard');
    expect(contextTierForPlatform('')).toBe('standard');
    expect(contextTierForPlatform(undefined)).toBe('standard');
    expect(contextTierForPlatform('constructor')).toBe('standard'); // prototype-chain name must not resolve
  });

  it('renderPomContextLine matches the buildTextContext framing and is empty when absent', () => {
    const { system } = buildTextContext({ platform: 'gmb', pomContext: 'Acme facts' });
    expect(system).toContain(renderPomContextLine('Acme facts'));
    expect(renderPomContextLine('')).toBe('');
  });

  it('renderPomAssetsLine collapses hostile names, caps the list, and handles count-only manifests', () => {
    const line = renderPomAssetsLine({
      count: 15,
      images: 12,
      videos: 2,
      recent: [{ name: 'a\nb.jpg', type: 'image' }, { name: '', type: 'image' }, { name: 'x'.repeat(200), type: 'video' }]
    });
    expect(line).toMatch(/12 images, 2 videos/);
    expect(line).toContain('a b.jpg'); // newline collapsed, not injected
    expect(line).not.toMatch(/x{100}/); // long names truncated
    expect(renderPomAssetsLine({ count: 4 })).toMatch(/4 assets/);
    expect(renderPomAssetsLine(null)).toBe('');
    expect(renderPomAssetsLine({})).toBe('');
  });

  it('renderPomBrandPart matches the buildImagePrompt framing and is empty when absent', () => {
    const out = buildImagePrompt({ prompt: 'a sunset', pomBrand: 'navy #001f3f, white' });
    expect(out).toContain(renderPomBrandPart('navy #001f3f, white'));
    expect(renderPomBrandPart('')).toBe('');
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
