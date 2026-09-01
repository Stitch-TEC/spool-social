import { lstat, readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isAlias, isMap, isScalar, isSeq, parseAllDocuments } from 'yaml'

const ACTION_SHA_PATTERN = /^([^@\s]+)@[0-9a-f]{40}$/
const DOCKER_DIGEST_PATTERN = /^docker:\/\/[^\s]+@sha256:[0-9a-f]{64}$/
const LOCAL_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/

function hasExpression(value) {
  return value.includes('${{') || value.includes('}}')
}

export function actionPinError(ref) {
  if (hasExpression(ref)) return 'Action references must be literal, not expressions'

  if (ref.startsWith('./')) {
    const path = ref.slice(2)
    const segments = path.split('/')
    if (
      !path ||
      ref.includes('\\') ||
      segments.some((segment) =>
        !segment || segment === '.' || segment === '..' || !LOCAL_SEGMENT_PATTERN.test(segment))
    ) {
      return 'Local actions must use a literal, traversal-free ./ path'
    }
    return null
  }

  if (ref.startsWith('docker://')) {
    return DOCKER_DIGEST_PATTERN.test(ref)
      ? null
      : 'Docker actions must use an immutable sha256 digest'
  }

  const match = ref.match(ACTION_SHA_PATTERN)
  if (!match) return 'External actions must be pinned to a full 40-character commit SHA'
  if (!match[1].includes('/')) return 'External actions must use owner/repository syntax'

  return null
}

function inspectNode(node, location, result) {
  if (node == null) return

  if (isAlias(node)) {
    result.errors.push(`${location}: YAML aliases are not allowed in workflows`)
    return
  }

  if (isSeq(node)) {
    for (const item of node.items) inspectNode(item, location, result)
    return
  }

  if (!isMap(node)) return

  for (const pair of node.items) {
    if (isAlias(pair.key)) {
      result.errors.push(`${location}: YAML aliases cannot be mapping keys`)
      inspectNode(pair.value, location, result)
      continue
    }

    if (!isScalar(pair.key) || typeof pair.key.value !== 'string') {
      result.errors.push(`${location}: workflow mapping keys must be literal strings`)
      inspectNode(pair.value, location, result)
      continue
    }

    const key = pair.key.value
    if (hasExpression(key)) {
      result.errors.push(`${location}: dynamic workflow mapping keys are not allowed: ${key}`)
    }

    if (key === 'uses') {
      result.checked += 1
      if (!isScalar(pair.value) || typeof pair.value.value !== 'string') {
        result.errors.push(`${location}: uses must be a direct literal string`)
      } else {
        const error = actionPinError(pair.value.value)
        if (error) result.errors.push(`${location}: ${error}: ${pair.value.value}`)
      }
    }

    inspectNode(pair.value, location, result)
  }
}

async function inspectWorkflow(filePath, fileName, result) {
  const stat = await lstat(filePath)
  if (stat.isSymbolicLink()) {
    result.errors.push(`${fileName}: workflow files must not be symbolic links`)
    return
  }
  if (!stat.isFile()) {
    result.errors.push(`${fileName}: workflow path must be a regular file`)
    return
  }

  const text = await readFile(filePath, 'utf8')
  const documents = parseAllDocuments(text, {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
    version: '1.2',
  })

  if (documents.length !== 1) {
    result.errors.push(`${fileName}: workflow must contain exactly one YAML document`)
    return
  }

  const [document] = documents
  if (document.errors.length || document.warnings.length) {
    for (const issue of [...document.errors, ...document.warnings]) {
      result.errors.push(`${fileName}: ${issue.message}`)
    }
    return
  }

  if (!isMap(document.contents)) {
    result.errors.push(`${fileName}: workflow document root must be a mapping`)
    return
  }

  inspectNode(document.contents, fileName, result)
}

export async function checkWorkflowPins(repoRoot = process.cwd()) {
  const workflowDir = resolve(repoRoot, '.github/workflows')
  const workflowDirStat = await lstat(workflowDir)
  if (workflowDirStat.isSymbolicLink() || !workflowDirStat.isDirectory()) {
    throw new Error('Workflow action pin check failed:\n.github/workflows must be a real directory')
  }

  const entries = (await readdir(workflowDir, { withFileTypes: true }))
    .filter((entry) => /\.ya?ml$/.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
  const result = { checked: 0, errors: [], files: entries.length }

  for (const entry of entries) {
    await inspectWorkflow(resolve(workflowDir, entry.name), entry.name, result)
  }

  if (result.errors.length) {
    throw new Error(`Workflow action pin check failed:\n${result.errors.join('\n')}`)
  }

  return { checked: result.checked, files: result.files }
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
