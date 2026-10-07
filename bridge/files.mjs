import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, isAbsolute } from 'node:path'
import { outputWriteError, resolvedOutputPath } from './workspace.mjs'

const MAX_FILE_BYTES = 25 * 1024 * 1024

function safePath(input, roots, { allowMissing = false } = {}) {
  const candidate = resolve(String(input ?? ''))
  const root = roots.find((entry) => {
    const rel = relative(entry, candidate)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  })
  if (!root) throw new Error('That path is outside Jarvis file roots.')
  return { candidate, root, allowMissing }
}

async function existingPath(input, roots) {
  const checked = safePath(input, roots)
  const real = await import('node:fs/promises').then(({ realpath }) => realpath(checked.candidate))
  safePath(real, roots)
  return real
}

const result = (text) => ({ content: [{ type: 'text', text }] })
const failure = (text) => ({ isError: true, content: [{ type: 'text', text }] })

/** Filesystem tools shared by Claude and OpenAI through the bridge. */
export function filesServer({ roots, allowWrites, workingDirectory, projectRoots = [] }) {
  const rootDescription = roots.join(', ')
  return createSdkMcpServer({
    name: 'jarvis_files',
    version: '1.0.0',
    tools: [
      tool(
        'fs_read',
        `Read a text file within these permitted roots: ${rootDescription}`,
        { path: z.string(), startLine: z.number().int().min(1).optional(), endLine: z.number().int().min(1).optional() },
        async ({ path, startLine, endLine }) => {
          try {
            const real = await existingPath(path, roots)
            const info = await stat(real)
            if (!info.isFile()) return failure('That path is not a file.')
            if (info.size > MAX_FILE_BYTES) return failure('The file is larger than the permitted read limit.')
            const text = await readFile(real, 'utf8')
            const lines = text.split('\n')
            const from = Math.max(1, startLine ?? 1)
            const to = Math.min(lines.length, endLine ?? lines.length)
            return result(lines.slice(from - 1, to).map((line, index) => `${from + index}: ${line}`).join('\n'))
          } catch (error) {
            return failure(`The file could not be read: ${error.message}`)
          }
        },
      ),
      tool(
        'fs_list',
        'List entries in a permitted directory.',
        { path: z.string() },
        async ({ path }) => {
          try {
            const real = await existingPath(path, roots)
            const entries = await readdir(real, { withFileTypes: true })
            return result(entries.map((entry) => `${entry.isDirectory() ? 'DIR ' : 'FILE'} ${entry.name}`).join('\n') || '(empty)')
          } catch (error) {
            return failure(`The directory could not be listed: ${error.message}`)
          }
        },
      ),
      tool(
        'fs_search',
        'Search text files below a permitted directory. Returns matching file paths and lines.',
        { query: z.string().min(1), path: z.string().optional() },
        async ({ query, path }) => {
          const matches = []
          const walk = async (directory) => {
            if (matches.length >= 100) return
            for (const entry of await readdir(directory, { withFileTypes: true })) {
              if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
              const full = resolve(directory, entry.name)
              if (entry.isDirectory()) await walk(full)
              else {
                try {
                  const info = await stat(full)
                  if (info.size > MAX_FILE_BYTES) continue
                  const text = await readFile(full, 'utf8')
                  for (const [index, line] of text.split('\n').entries()) {
                    if (line.toLowerCase().includes(query.toLowerCase())) {
                      matches.push(`${full}:${index + 1}: ${line.trim()}`)
                      if (matches.length >= 100) return
                    }
                  }
                } catch { /* binary or unreadable file */ }
              }
            }
          }
          try {
            const base = await existingPath(path ?? roots[0], roots)
            await walk(base)
            return result(matches.join('\n') || 'No matches.')
          } catch (error) {
            return failure(`The search could not be completed: ${error.message}`)
          }
        },
      ),
      tool(
        'fs_write',
        allowWrites ? 'Write a text file within a permitted root.' : 'Write a text file. This is disabled because Jarvis is in read-only mode.',
        { path: z.string(), content: z.string() },
        async ({ path, content }) => {
          if (!allowWrites) return failure('Blocked: filesystem writes are disabled.')
          try {
            const destination = workingDirectory ? resolve(workingDirectory, path) : path
            const reason = workingDirectory && outputWriteError(destination, workingDirectory, projectRoots)
            if (reason) return failure(reason)
            const checked = safePath(destination, roots)
            const target = resolvedOutputPath(checked.candidate)
            safePath(target, roots)
            await mkdir(dirname(target), { recursive: true })
            await writeFile(target, content, { encoding: 'utf8', mode: 0o600 })
            return result(`Wrote ${target}.`)
          } catch (error) {
            return failure(`The file could not be written: ${error.message}`)
          }
        },
      ),
    ],
  })
}
