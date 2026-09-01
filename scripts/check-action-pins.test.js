import { describe, expect, it } from 'vitest'
import { actionPinError, usesRefsIn } from './check-action-pins.mjs'

const ACTION_SHA = 'a'.repeat(40)
const IMAGE_DIGEST = 'b'.repeat(64)

describe('workflow action pin guard', () => {
  it('allows local actions', () => {
    expect(actionPinError('./.github/actions/build')).toBeNull()
  })

  it('allows external actions pinned to a full commit SHA', () => {
    expect(actionPinError(`actions/checkout@${ACTION_SHA}`)).toBeNull()
  })

  it('rejects mutable external action refs', () => {
    expect(actionPinError('actions/checkout@v7')).toMatch(/40-character/)
  })

  it('allows Docker actions pinned by digest', () => {
    expect(actionPinError(`docker://alpine@sha256:${IMAGE_DIGEST}`)).toBeNull()
  })

  it('rejects mutable Docker action refs', () => {
    expect(actionPinError('docker://alpine:3.23')).toMatch(/sha256/)
  })

  it('extracts quoted and commented uses refs', () => {
    const refs = usesRefsIn(`
      - uses: "actions/checkout@${ACTION_SHA}" # v7.0.1
      - uses: './.github/actions/build'
    `)

    expect(refs.map(({ ref }) => ref)).toEqual([
      `actions/checkout@${ACTION_SHA}`,
      './.github/actions/build',
    ])
  })
})
