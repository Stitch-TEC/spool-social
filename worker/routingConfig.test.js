import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const config = readFileSync('wrangler.toml', 'utf8');
const workerSource = readFileSync('worker/index.js', 'utf8');

describe('Worker/static asset routing configuration', () => {
  it('keeps default miss-to-Worker routing for APIs, media, and stale assets', () => {
    expect(config).toMatch(/^not_found_handling\s*=\s*"single-page-application"$/m);
    expect(config).not.toMatch(/^\s*run_worker_first\s*=/m);
  });

  it('accounts for every request family routed explicitly by the Worker', () => {
    const routeLiterals = [
      ...workerSource.matchAll(/url\.pathname\s*===\s*['"]([^'"]+)['"]/g),
      ...workerSource.matchAll(/url\.pathname\.startsWith\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map((match) => match[1]);
    const families = [...new Set(routeLiterals.map((path) => path.split('/')[1]))].sort();

    expect(families).toEqual(['api', 'media']);
    expect(workerSource).toMatch(/const ASSET_PATH = \/\^\\\/assets\\\//);
    expect(workerSource).toContain('return await serveSpaAsset(request, env);');
  });
});
