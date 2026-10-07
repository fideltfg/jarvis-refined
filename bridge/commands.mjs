import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import { saveOutputLog } from './workspace.mjs'

const result = (text, isError = false) => ({ isError, content: [{ type: 'text', text }] })

/** Shell execution for text providers; Claude already has its built-in Bash tool. */
export function commandsServer({ roots, allowWrites, workingDirectory }) {
  return createSdkMcpServer({
    name: 'jarvis_commands',
    version: '1.0.0',
    tools: [tool(
      'run_command',
      allowWrites
        ? 'Run a shell command in a permitted working directory, for example a build or test. Commands can access the host beyond that directory.'
        : 'Run a shell command. Disabled in read-only mode.',
      { command: z.string().min(1), cwd: z.string() },
      async ({ command, cwd }) => {
        if (!allowWrites) return result('Blocked: shell commands are disabled in read-only mode.', true)
        let directory
        try {
          directory = await realpath(cwd)
          if (!roots.some((root) => {
            const rel = relative(root, directory)
            return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
          })) return result('That working directory is outside Jarvis file roots.', true)
        } catch (error) {
          return result(`The working directory could not be opened: ${error.message}`, true)
        }
        return new Promise((resolve) => {
          execFile('/bin/sh', ['-c', command], { cwd: directory, ...(workingDirectory ? { env: { ...process.env, TMPDIR: `${workingDirectory}/tmp` } } : {}), timeout: 120_000, maxBuffer: 128 * 1024 }, (error, stdout, stderr) => {
            const output = [stdout, stderr].filter(Boolean).join('\n') || '(no output)'
            if (workingDirectory) {
              try {
                saveOutputLog(workingDirectory, 'commands', { command, cwd: directory, stdout, stderr, exit: error?.code ?? (error ? error.message : 0) })
              } catch (storageError) {
                return resolve(result(`Command finished, but its output could not be saved: ${storageError.message}\n${output}`, true))
              }
            }
            resolve(result(`${output}\nExit: ${error?.code ?? (error ? error.message : 0)}`, Boolean(error)))
          })
        })
      },
    )],
  })
}