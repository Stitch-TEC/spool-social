import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { actionPinError, checkWorkflowPins } from './check-action-pins.mjs'

const ACTION_SHA = 'a'.repeat(40)
const IMAGE_DIGEST = 'b'.repeat(64)

function workflowWithStep(step) {
  return `name: Pin fixture
on: push
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
${step.split('\n').map((line) => `      ${line}`).join('\n')}
`
}

async function withWorkflow(text, run) {
  const root = await mkdtemp(join(tmpdir(), 'spool-action-pins-'))
  const workflowDir = join(root, '.github', 'workflows')
  await mkdir(workflowDir, { recursive: true })
  await writeFile(join(workflowDir, 'fixture.yml'), text)

  try {
    return await run({ root, workflowDir })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function scan(text) {
  return withWorkflow(text, ({ root }) => checkWorkflowPins(root))
}

describe('workflow action pin guard', () => {
  it('enumerates spacing, quoted-key, flow-map, and anchored-step forms', async () => {
    const result = await scan(workflowWithStep(`- uses : actions/checkout@${ACTION_SHA}
- "uses": actions/setup-node@${ACTION_SHA}
- { uses: actions/setup-java@${ACTION_SHA} }
- &review
  uses: actions/dependency-review-action@${ACTION_SHA}`))

    expect(result).toEqual({ checked: 4, files: 1 })
  })

  it.each([
    ['spacing around the key separator', '- uses : actions/checkout@v7'],
    ['a quoted uses key', '- "uses": actions/checkout@v7'],
    ['a flow mapping', '- { uses: actions/checkout@v7 }'],
    ['an anchored step', '- &checkout\n  uses: actions/checkout@v7'],
  ])('rejects a mutable ref hidden behind %s', async (_name, step) => {
    await expect(scan(workflowWithStep(step))).rejects.toThrow(/40-character/)
  })

  it('accepts quoted and commented canonical refs', async () => {
    await expect(scan(workflowWithStep(
      `- "uses": "actions/checkout@${ACTION_SHA}" # v7.0.1`,
    ))).resolves.toEqual({ checked: 1, files: 1 })
  })

  it('rejects an alias used as a mapping key', async () => {
    const fixture = `name: Alias key
on: push
alias-name: &uses uses
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - ? *uses
        : actions/checkout@${ACTION_SHA}
`
    await expect(scan(fixture)).rejects.toThrow(/aliases cannot be mapping keys/)
  })

  it('rejects an alias used as an indirect value', async () => {
    const fixture = `name: Alias value
on: push
action-ref: &action-ref actions/checkout@${ACTION_SHA}
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: *action-ref
`
    await expect(scan(fixture)).rejects.toThrow(/direct literal|aliases are not allowed/)
  })

  it('rejects multiple YAML documents even when every ref is pinned', async () => {
    const fixture = `${workflowWithStep(`- uses: actions/checkout@${ACTION_SHA}`)}---
${workflowWithStep(`- uses: actions/setup-node@${ACTION_SHA}`)}`
    await expect(scan(fixture)).rejects.toThrow(/exactly one YAML document/)
  })

  it('rejects malformed YAML', async () => {
    await expect(scan('name: Broken\njobs: [\n')).rejects.toThrow(/flow sequence|YAML/i)
  })

  it('rejects traversal in local action paths', async () => {
    await expect(scan(workflowWithStep('- uses: ./../outside'))).rejects.toThrow(/traversal-free/)
  })

  it('rejects dynamic action expressions', async () => {
    const expression = '${{ matrix.action }}'
    await expect(scan(workflowWithStep(`- uses: ${expression}`))).rejects.toThrow(/literal/)
  })

  it('permits safe literal local actions', async () => {
    await expect(scan(workflowWithStep('- uses: ./.github/actions/build')))
      .resolves.toEqual({ checked: 1, files: 1 })
  })

  it('requires Docker actions to be digest-pinned', async () => {
    await expect(scan(workflowWithStep('- uses: docker://alpine:3.23')))
      .rejects.toThrow(/sha256/)
    await expect(scan(workflowWithStep(`- uses: docker://alpine@sha256:${IMAGE_DIGEST}`)))
      .resolves.toEqual({ checked: 1, files: 1 })
  })

  it('rejects workflow-file symlinks without following them', async () => {
    await withWorkflow(workflowWithStep(`- uses: actions/checkout@${ACTION_SHA}`), async ({ root, workflowDir }) => {
      const target = join(root, 'target.yml')
      await writeFile(target, workflowWithStep(`- uses: actions/setup-node@${ACTION_SHA}`))
      await symlink(target, join(workflowDir, 'linked.yml'))

      await expect(checkWorkflowPins(root)).rejects.toThrow(/symbolic links/)
    })
  })

  it('rejects mutable refs at the value validator boundary', () => {
    expect(actionPinError('actions/checkout@v7')).toMatch(/40-character/)
  })
})
