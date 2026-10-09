import { open, readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, isAbsolute, join, relative } from 'node:path'
import { extractText } from 'unpdf'
import { WORK_DIR } from '../bridge/workspace.mjs'

const MAX_BYTES = 512_000
const DOCUMENT = /\.(md|txt|json|csv|html|xml|ya?ml|log)$/i
const REFERENCE_DOCUMENT = /\.(md|txt|json|csv|html|xml|ya?ml|log|pdf)$/i
const FOLDERS = ['reports', 'artifacts']
/** Check canonical path containment for report and reference reads. */
const inside = (root, path) => {
  const suffix = relative(root, path)
  return suffix !== '..' && !suffix.startsWith('../') && !isAbsolute(suffix)
}

/** List task report files or read one bounded text preview within its workspace. */
export async function taskReports(task, file = null) {
  const result = { result: task.result ?? null, failure: task.failure ?? null, files: [] }
  if (!task.workspace?.path) {
    if (file !== null) throw new Error('This task has no saved reports.')
    return result
  }
  let workspace
  try {
    workspace = await realpath(task.workspace.path)
  } catch (error) {
    if (error.code !== 'ENOENT' || file !== null) throw error
    return result
  }
  if (file !== null) {
    if (typeof file !== 'string' || !file || isAbsolute(file) || !DOCUMENT.test(file)) throw new Error('Invalid report filename.')
    const parts = file.split('/')
    const folder = FOLDERS.includes(parts[0]) ? parts.shift() : 'reports'
    if (!parts.length || parts.some((part) => !part || part === '.' || part === '..')) throw new Error('Invalid report filename.')
    const root = await realpath(join(workspace, folder))
    if (!inside(workspace, root)) throw new Error('Report folder is outside the task workspace.')
    const path = await realpath(join(root, ...parts))
    if (!inside(root, path)) throw new Error('Report is outside the task report folder.')
    const handle = await open(path, 'r')
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Report is not a text file or exceeds the 512 KB preview limit.')
      const buffer = Buffer.alloc(MAX_BYTES + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      if (bytesRead > MAX_BYTES) throw new Error('Report exceeds the 512 KB preview limit.')
      return { file, content: buffer.subarray(0, bytesRead).toString('utf8') }
    } finally { await handle.close() }
  }
  for (const folder of FOLDERS) {
    try {
      const root = await realpath(join(workspace, folder))
      if (!inside(workspace, root)) throw new Error(`${folder} folder is outside the task workspace.`)
      const files = []
      /** Walk one report folder without following symlinks or exceeding the cap. */
      async function list(directory, prefix = '') {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (files.length >= 200) return
          const name = prefix ? `${prefix}/${entry.name}` : entry.name
          if (entry.isDirectory()) await list(join(directory, entry.name), name)
          else if (entry.isFile() && DOCUMENT.test(name)) files.push(`${folder}/${name}`)
        }
      }
      await list(root)
      result.files.push(...files)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (result.files.length >= 200) break
  }
  result.files.sort((left, right) => left === 'reports/latest.md' ? -1 : right === 'reports/latest.md' ? 1 : left.localeCompare(right))
  return result
}

/** Merge valid result/failure references, deduplicate targets, and cap the list. */
export function taskReferences(task) {
  const refs = [...(task.result?.references ?? []), ...(task.failure?.references ?? [])]
  const seen = new Set()
  return refs.filter((reference) => {
    // Ignore malformed references and repeated URLs or local paths.
    if (!reference || typeof reference.title !== 'string' || (typeof reference.url !== 'string' && typeof reference.path !== 'string')) return false
    const key = reference.url ?? reference.path
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 20)
}

/** Resolve and read one task reference inside its workspace or approved roots. */
export async function readTaskReference(task, index, { roots = [WORK_DIR, join(homedir(), 'Projects'), ...(process.env.JARVIS_PROJECT_ROOTS ?? '').split(',').map((root) => root.trim()).filter(Boolean)] } = {}) {
  const reference = taskReferences(task)[index]
  if (!Number.isInteger(index) || index < 0 || !reference?.path) throw new Error('This document reference is unavailable.')
  if (!task.workspace?.path) throw new Error('This task has no approved workspace.')
  if (reference.path.includes('\0') || !REFERENCE_DOCUMENT.test(reference.path)) throw new Error('Unsupported document type.')
  const workspace = await realpath(task.workspace.path)
  const asked = isAbsolute(reference.path) ? reference.path : join(workspace, reference.path)
  const path = await realpath(asked)
  const permitted = [workspace, ...roots]
  let allowed = false
  for (const rawRoot of permitted) {
    try {
      if (inside(await realpath(rawRoot), path)) { allowed = true; break }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  if (!allowed) throw new Error('This document is outside the task workspace and approved project roots.')
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_BYTES) throw new Error('Document exceeds the 512 KB preview limit or is not a regular file.')
    const data = await handle.readFile()
    // Extract PDF text while reading all other supported documents as UTF-8.
    const extracted = extname(path).toLowerCase() === '.pdf'
      ? (await extractText(data, { mergePages: true })).text
      : data.toString('utf8')
    if (Buffer.byteLength(extracted, 'utf8') > MAX_BYTES) throw new Error('Document preview exceeds the 512 KB text limit.')
    const content = extracted
    return { file: reference.title, content }
  } finally { await handle.close() }
}