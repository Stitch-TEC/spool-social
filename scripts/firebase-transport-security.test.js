// @vitest-environment node
import { readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const root = new URL('../', import.meta.url)
const require = createRequire(import.meta.url)
const json = async path => JSON.parse(await readFile(new URL(path, root), 'utf8'))

describe('temporary parent-scoped Firestore transport repair', () => {
  it('keeps the existing Firebase parent and scopes exact transports to that reviewed version', async () => {
    const manifest = await json('package.json')
    const lock = await json('package-lock.json')
    expect(manifest.dependencies.firebase).toBe('^12.7.0')
    expect(lock.packages['node_modules/firebase'].version).toBe('12.7.0')
    expect(lock.packages['node_modules/@firebase/firestore'].version).toBe('4.9.3')
    expect(manifest.overrides).toEqual({
      '@firebase/firestore@4.9.3': { '@grpc/grpc-js': '1.14.5', '@grpc/proto-loader': '0.8.1' },
      esbuild: '^0.28.1', undici: '^7.30.0',
    })
    const workflow = parse(await readFile(new URL('.github/workflows/ci.yml', root), 'utf8'))
    expect(workflow.jobs.audit.steps.find(step => step.name === 'npm audit (high severity and above)').run)
      .toBe('npm audit --audit-level=high')
  })

  it('has no hidden old transport or brace-expansion copy in the locked and installed tree', async () => {
    const lock = await json('package-lock.json')
    for (const [name, version] of [
      ['@grpc/grpc-js', '1.14.5'], ['@grpc/proto-loader', '0.8.1'], ['brace-expansion', '1.1.21'],
    ]) {
      const copies = Object.entries(lock.packages).filter(([path]) => path.endsWith(`node_modules/${name}`))
      expect(copies.length, name).toBeGreaterThan(0)
      for (const [path, entry] of copies) {
        expect(entry.version, path).toBe(version)
        const installed = await json(`${path}/package.json`)
        expect(installed.version, path).toBe(version)
        expect(installed.name, path).toBe(name)
      }
    }
    const firestore = createRequire(require.resolve('@firebase/firestore'))
    expect(firestore('@grpc/grpc-js/package.json').version).toBe('1.14.5')
    expect(firestore('@grpc/proto-loader/package.json').version).toBe('0.8.1')
    expect(createRequire(firestore.resolve('@grpc/grpc-js'))('@grpc/proto-loader/package.json').version).toBe('0.8.1')
  })

  it('loads real Node CJS and ESM exports with external patched transport dependencies', async () => {
    const parent = dirname(require.resolve('@firebase/firestore/package.json'))
    const metadata = require('@firebase/firestore/package.json')
    const cjs = require('@firebase/firestore')
    const esm = await import(pathToFileURL(join(parent, metadata.exports['.'].node.import)).href)
    for (const module of [cjs, esm]) for (const name of [
      'initializeFirestore', 'connectFirestoreEmulator', 'runTransaction', 'writeBatch', 'onSnapshot', 'terminate',
    ]) expect(typeof module[name], name).toBe('function')
    for (const relative of Object.values(metadata.exports['.'].node)) {
      const text = await readFile(join(parent, relative), 'utf8')
      expect(text).toMatch(/(?:require\('@grpc\/grpc-js'\)|from '@grpc\/grpc-js')/)
      expect(text).toMatch(/(?:require\('@grpc\/proto-loader'\)|from '@grpc\/proto-loader')/)
    }
  })

  it('keeps gRPC out of Firestore browser exports (the actual Vite graph is a separate build gate)', async () => {
    const parent = dirname(require.resolve('@firebase/firestore/package.json'))
    const metadata = require('@firebase/firestore/package.json')
    for (const relative of Object.values(metadata.exports['.'].browser)) {
      const text = await readFile(join(parent, relative), 'utf8')
      expect(text).not.toContain('@grpc/grpc-js')
      expect(text).not.toContain('@grpc/proto-loader')
    }
    expect(await readdir(join(parent, 'dist'))).toContain('index.esm.js')
  })

  it('retains ordinary brace expansion through the patched existing minimatch dependency', () => {
    const minimatch = createRequire(require.resolve('minimatch'))
    const expand = minimatch('brace-expansion')
    expect(expand('assets/{one,two}.{png,webp}')).toEqual([
      'assets/one.png', 'assets/one.webp', 'assets/two.png', 'assets/two.webp',
    ])
    // A bounded regression input exercises nested groups without an unbounded stress payload.
    expect(() => expand('{'.repeat(200) + 'a,b' + '}'.repeat(200))).not.toThrow()
  })
})
