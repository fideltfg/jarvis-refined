import { lstat, readdir, realpath, rm, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { WORK_DIR } from './workspace.mjs'

export const MAX_ENTRIES = 20000
export const MAX_PREVIEW_BYTES = 25 * 1024 * 1024
const MAX_DEPTH = 12
const SKIPPED = new Set(['node_modules'])
const hidden = (name) => name.startsWith('.')
const ACTIVE = ['queued', 'running', 'awaiting_approval']

// Only these types render inline; HTML and SVG are served as text so they can never script the bridge origin.
const INLINE = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.json': 'text/plain; charset=utf-8', '.jsonl': 'text/plain; charset=utf-8', '.csv': 'text/plain; charset=utf-8',
  '.html': 'text/plain; charset=utf-8', '.svg': 'text/plain; charset=utf-8', '.xml': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8', '.yml': 'text/plain; charset=utf-8',
}

export const previewKind = (path) => {
  const type = INLINE[extname(path).toLowerCase()]
  return !type ? null : type.startsWith('image/') ? 'image' : type === 'application/pdf' ? 'pdf' : 'text'
}

/** Content headers for a served file; downloads are always an opaque attachment. */
export function fileHeaders(path, size, download) {
  const name = path.split('/').pop().replace(/[^\w.-]+/g, '_')
  if (download) {
    return {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${name}"`,
      'content-length': String(size),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
      'cache-control': 'no-store',
    }
  }
  const type = INLINE[extname(path).toLowerCase()] ?? 'application/octet-stream'
  return {
    'content-type': type,
    'content-disposition': 'inline',
    'content-length': String(size),
    'x-content-type-options': 'nosniff',
    // Chrome refuses to render a PDF under a sandbox policy; PDFs and images are inert under nosniff.
    ...(type.startsWith('text/') && { 'content-security-policy': "sandbox; default-src 'none'" }),
    'cache-control': 'no-store',
  }
}

const BLOCKED = new Set(['sessions'])

const scopeOf = (parts) => {
  if (parts.length < 2 || BLOCKED.has(parts[0])) return null
  const task = parts[0] === 'goals' && parts[2] === 'tasks' ? parts[3] : null
  return { scope: parts[0], owner: parts[1], task }
}

export async function listFiles({ root = WORK_DIR, limit = MAX_ENTRIES } = {}) {
  let base
  try { base = await realpath(root) } catch (error) {
    if (error.code === 'ENOENT') return { files: [], truncated: false }
    throw error
  }
  const files = []
  let truncated = false
  async function walk(directory, parts) {
    if (truncated || parts.length > MAX_DEPTH) return
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (truncated) return
      if (SKIPPED.has(entry.name) || hidden(entry.name)) continue
      const next = [...parts, entry.name]
      if (entry.isDirectory()) { await walk(join(directory, entry.name), next); continue }
      if (!entry.isFile()) continue
      const scope = scopeOf(next)
      if (!scope) continue
      if (files.length >= limit) { truncated = true; return }
      try {
        const info = await stat(join(directory, entry.name))
        files.push({ path: next.join('/'), size: info.size, modified: info.mtime.toISOString(), ...scope, preview: previewKind(entry.name) })
      } catch { /* removed while listing */ }
    }
  }
  const tops = (await readdir(base, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !hidden(entry.name) && !BLOCKED.has(entry.name) && !SKIPPED.has(entry.name))
    .map((entry) => entry.name)
    // The goals tree is by far the largest; walking it last keeps it from starving the rest of the cap.
    .sort((left, right) => Number(left === 'goals') - Number(right === 'goals') || left.localeCompare(right))
  for (const top of tops) await walk(join(base, top), [top])
  files.sort((left, right) => right.modified.localeCompare(left.modified))
  return { files, truncated }
}

/** Resolves a listed relative path to a regular file with no symlink anywhere along it. */
export async function resolveFile(path, { root = WORK_DIR } = {}) {
  if (typeof path !== 'string' || !path || path.length > 1000 || path.includes('\0') || path.includes('\\') || path.startsWith('/')) {
    throw new Error('Invalid file path.')
  }
  const parts = path.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..' || hidden(part) || SKIPPED.has(part)) || !scopeOf(parts)) throw new Error('Invalid file path.')
  const base = await realpath(root)
  const expected = join(base, ...parts)
  let real
  try { real = await realpath(expected) } catch (error) {
    if (error.code === 'ENOENT') throw new Error('File not found.')
    throw error
  }
  if (real !== expected) throw new Error('File not found.')
  const info = await lstat(real)
  if (!info.isFile()) throw new Error('File not found.')
  return { real, info, parts, ...scopeOf(parts) }
}

export async function deleteFile(path, { root = WORK_DIR, allowWrites = false, activeTaskIds = null } = {}) {
  if (!allowWrites) throw new Error('Deleting files is disabled. Start JARVIS with writes enabled.')
  if (!(activeTaskIds instanceof Set)) throw new Error('Task state is unavailable, so the file was not deleted.')
  const file = await resolveFile(path, { root })
  if (file.task && activeTaskIds.has(file.task)) throw new Error('This file belongs to a task that is still running.')
  await rm(file.real)
  return { path, deleted: true }
}

/** IDs of tasks whose workspaces must not be touched, from the agent board. */
export const activeTasksOf = (board) => new Set([
  ...(board?.running ?? []),
  ...(board?.goals ?? []).flatMap((goal) => (goal.tasks ?? []).filter((task) => ACTIVE.includes(task.status)).map((task) => task.id)),
])

export async function handleFilesRequest(message, { api, allowWrites, send, root = WORK_DIR }) {
  if (message.type !== 'files_request') return false
  if (typeof message.requestId !== 'string' || !message.requestId || message.requestId.length > 100) return true
  const reply = (body) => send({ type: 'files_reply', requestId: message.requestId, ...body })
  try {
    if (message.action === 'list') {
      reply({ result: { ...(await listFiles({ root })), canDelete: allowWrites } })
    } else if (message.action === 'delete') {
      const activeTaskIds = activeTasksOf(await api?.board?.({ history: true }))
      reply({ result: await deleteFile(message.path, { root, allowWrites, activeTaskIds }) })
    } else throw new Error('Unknown file action.')
  } catch (err) { reply({ error: String(err.message ?? err) }) }
  return true
}
