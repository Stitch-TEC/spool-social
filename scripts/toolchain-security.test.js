// @vitest-environment node
import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const root = new URL('../', import.meta.url)
const require = createRequire(import.meta.url)
const json = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'))

describe('reviewed development-tool security', () => {
  it('keeps the manifest, lock and actual release command on one exact Wrangler version', async () => {
    const manifest = await json('package.json')
    const lock = await json('package-lock.json')
    expect(manifest.devDependencies.wrangler).toBe('4.131.0')
    expect(manifest.devDependencies.vitest).toBe('4.1.11')
    expect(lock.packages[''].devDependencies).toEqual(manifest.devDependencies)
    expect(lock.packages['node_modules/wrangler'].version).toBe('4.131.0')
    expect(lock.packages['node_modules/wrangler'].dependencies.miniflare).toBe('5.20260910.0-alpha')
    expect(lock.packages['node_modules/miniflare'].version).toBe('5.20260910.0-alpha')
    expect(lock.packages['node_modules/miniflare'].dependencies.sharp).toBe('0.35.4')

    const workflow = parse(await readFile(new URL('.github/workflows/deploy.yml', root), 'utf8'))
    const steps = workflow.jobs.deploy.steps
    const toolchain = steps.find(step => step.name === 'Verify deploy toolchain')
    expect(toolchain.run).toContain('test "$(node --version)" = "v22.19.0"')
    expect(toolchain.run).toContain('test "$(./node_modules/.bin/wrangler --version)" = "4.131.0"')
    expect(steps.find(step => step.name === 'Deploy Worker').run).toBe('./node_modules/.bin/wrangler deploy')
    const installIndex = steps.findIndex(step => step.run === 'npm ci')
    expect(installIndex).toBeGreaterThanOrEqual(0)
    expect(installIndex).toBeLessThan(steps.indexOf(toolchain))
  })

  it('has no hidden older copy of any patched advisory package in the lock', async () => {
    const lock = await json('package-lock.json')
    const fixed = {
      sharp: '0.35.4',
      vitest: '4.1.11',
      '@vitest/mocker': '4.1.11',
      'js-yaml': '4.3.2',
      'baseline-browser-mapping': '2.11.25',
    }
    for (const [name, version] of Object.entries(fixed)) {
      const copies = Object.entries(lock.packages).filter(([path]) => path.endsWith(`node_modules/${name}`))
      expect(copies.length, name).toBeGreaterThan(0)
      for (const [path, entry] of copies) {
        expect(entry.version, path).toBe(version)
        expect(entry.dev, path).toBe(true)
      }
    }
  })

  it('loads the patched native library through Miniflare’s dependency resolution', () => {
    const miniflareRequire = createRequire(require.resolve('miniflare'))
    const sharp = miniflareRequire('sharp')
    expect(sharp.versions.sharp).toBe('0.35.4')
    expect(sharp.versions.heif).toBe('1.23.2')
    expect(require.resolve('sharp')).toBe(miniflareRequire.resolve('sharp'))
  })

  it('round-trips a synthetic AVIF with the actual loaded patched native decoder', async () => {
    const miniflareRequire = createRequire(require.resolve('miniflare'))
    const sharp = miniflareRequire('sharp')
    const raw = Buffer.from([25, 80, 140, 70, 150, 30, 230, 60, 15, 10, 40, 190])
    const encoded = await sharp(raw, { raw: { width: 2, height: 2, channels: 3 } })
      .avif({ lossless: true }).toBuffer()
    const decoded = await sharp(encoded).raw().toBuffer({ resolveWithObject: true })
    expect(decoded.info).toMatchObject({ width: 2, height: 2, channels: 3 })
    expect(decoded.data).toEqual(raw)
  })
})
