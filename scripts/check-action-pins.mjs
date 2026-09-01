import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ACTION_SHA_PATTERN = /^[^@\s]+@[0-9a-f]{40}$/
const DOCKER_DIGEST_PATTERN = /^docker:\/\/[^\s]+@sha256:[0-9a-f]{64}$/

export function actionPinError(ref) {
  if (ref.startsWith('./')) return null

  if (ref.startsWith('docker://')) {
    return DOCKER_DIGEST_PATTERN.test(ref)
      ? null
      : 'Docker actions must use an immutable sha256 digest'
  }

  if (!ref.includes('/')) return 'External actions must use owner/repository syntax'
  if (!ACTION_SHA_PATTERN.test(ref)) {
    return 'External actions must be pinned to a full 40-character commit SHA'
  }

  return null
}

export function usesRefsIn(text) {
  const refs = []

  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const match = line.match(/^\s*(?:-\s*)?uses:\s*(.*?)\s*$/)
    if (!match) continue

    const withoutComment = match[1].replace(/\s+#.*$/, '').trim()
    const quote = withoutComment[0]
    const ref = quote === '"' || quote === "'"
      ? withoutComment.slice(1, withoutComment.lastIndexOf(quote))
      : withoutComment

    refs.push({ line: index + 1, ref })
  }

  return refs
}

export async function checkWorkflowPins(repoRoot = process.cwd()) {
  const workflowDir = resolve(repoRoot, '.github/workflows')
  const files = (await readdir(workflowDir))
    .filter((file) => /\.ya?ml$/.test(file))
    .sort()
  const errors = []
  let checked = 0

  for (const file of files) {
    const text = await readFile(resolve(workflowDir, file), 'utf8')
    for (const use of usesRefsIn(text)) {
      checked += 1
      const error = actionPinError(use.ref)
      if (error) errors.push(`${file}:${use.line}: ${error}: ${use.ref || '(empty)'}`)
    }
  }

  if (errors.length) {
    throw new Error(`Workflow action pin check failed:\n${errors.join('\n')}`)
  }

  return { checked, files: files.length }
}

async function main() {
  const result = await checkWorkflowPins()
  console.log(`Verified ${result.checked} action reference(s) across ${result.files} workflow file(s).`)
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
