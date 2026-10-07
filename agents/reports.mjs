import { open, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'

const MAX_BYTES = 512_000
const DOCUMENT = /\.(md|txt|json|csv|html|xml|ya?ml|log)$/i
const FOLDERS = ['reports', 'artifacts']
const inside = (root, path) => {
  const suffix = relative(root, path)
  return suffix !== '..' && !suffix.startsWith('../') && !isAbsolute(suffix)
}

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