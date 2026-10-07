import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createToolBroker } from '../bridge/tool-broker.mjs'
import { providerModels, textProvider } from '../bridge/providers.mjs'
import { listEndpoints } from '../bridge/endpoints.mjs'
import { fetchText } from '../bridge/net.mjs'
import { expandHome } from './policy.mjs'

export function scheduleModels(env = process.env) {
  const models = providerModels(env)
  const local = [...new Set(listEndpoints(env).filter((endpoint) => endpoint.kind === 'openai').map((endpoint) => endpoint.model))]
  delete models.local
  if (local.length) models.local = local
  return models
}

const definition = (name, description, properties, required) => ({
  type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
})
const string = { type: 'string' }
const nativeTools = [
  definition('Read', 'Read a UTF-8 file.', { file_path: string }, ['file_path']),
  definition('Write', 'Write a UTF-8 file.', { file_path: string, content: string }, ['file_path', 'content']),
  definition('Edit', 'Replace one exact, unique occurrence in a UTF-8 file.', { file_path: string, old_string: string, new_string: string }, ['file_path', 'old_string', 'new_string']),
  definition('Bash', 'Run a shell command in the task workspace.', { command: string }, ['command']),
  definition('WebFetch', 'Fetch a public HTTP(S) page as text.', { url: string }, ['url']),
]

async function nativeCall(name, args, options) {
  const path = args.file_path && resolve(options.cwd, expandHome(args.file_path))
  if (name === 'Read') return (await readFile(path, 'utf8')).slice(0, 100000)
  if (name === 'Write') {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, args.content, 'utf8')
    return 'Written.'
  }
  if (name === 'Edit') {
    const content = await readFile(path, 'utf8')
    if (!args.old_string || content.split(args.old_string).length !== 2) throw new Error('The old text must occur exactly once.')
    await writeFile(path, content.replace(args.old_string, () => args.new_string), 'utf8')
    return 'Edited.'
  }
  if (name === 'Bash') return new Promise((accept, reject) => {
    execFile('/bin/bash', ['-c', args.command], {
      cwd: options.cwd, env: options.env, signal: options.abortController?.signal,
      timeout: 120000, maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (options.abortController?.signal.aborted) reject(error)
      else accept(`${stdout}${stderr}${error ? `\nCommand failed: ${error.message}` : ''}`)
    })
  })
  if (name === 'WebFetch') {
    const url = new URL(args.url)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP(S) URL without credentials.')
    const response = await fetchText(url.href, { maxBytes: 100000, timeoutMs: 10000 })
    return response.text
  }
  throw new Error('Unknown tool.')
}

export function textQuery(execution, { env = process.env, endpoint = null, streamFactory = textProvider, makeBroker = createToolBroker } = {}) {
  return async function* query({ prompt, options }) {
    const models = scheduleModels(env)
    if (!models[execution.provider]?.includes(execution.model)) {
      throw new Error(`Scheduled provider/model is unavailable: ${execution.provider}/${execution.model}. Configure it or edit the schedule.`)
    }
    options.abortController?.signal.throwIfAborted()
    const local = {}
    const external = {}
    for (const [name, server] of Object.entries(options.mcpServers ?? {})) {
      if (server.instance) local[name] = server
      else external[name] = { ...server, env: { ...options.env, ...(server.env ?? {}) } }
    }
    const broker = await makeBroker({ local, external, env: options.env })
    const tools = [...(options.cwd ? nativeTools : []), ...broker.tools()]
      .filter((entry) => !options.disallowedTools?.includes(entry.function.name))
    const allowed = new Set(tools.map((entry) => entry.function.name))
    let reported = false
    let toolCalls = 0
    try {
      const provider = execution.provider === 'local'
        ? endpoint ?? listEndpoints(env).find((entry) => entry.kind === 'openai' && entry.model === execution.model)
        : execution.provider
      options.abortController?.signal.throwIfAborted()
      await streamFactory(provider, env, execution.model)([
        { role: 'system', content: options.systemPrompt }, { role: 'user', content: prompt },
      ], options.abortController?.signal, () => {}, {
        tools, maxRounds: options.maxTurns, shouldStop: () => reported,
        callTool: async (name, args) => {
          options.abortController?.signal.throwIfAborted()
          if (!allowed.has(name)) return 'Blocked: unknown or disallowed tool.'
          if (args.file_path && options.cwd) args = { ...args, file_path: resolve(options.cwd, expandHome(args.file_path)) }
          const input = { tool_name: name, tool_input: args }
          for (const entry of options.hooks?.PreToolUse ?? []) {
            for (const hook of entry.hooks) {
              const result = await hook(input)
              if (result.hookSpecificOutput?.permissionDecision !== 'allow') {
                return `Blocked: ${result.hookSpecificOutput?.permissionDecisionReason ?? 'permission denied'}`
              }
            }
          }
          let result
          options.abortController?.signal.throwIfAborted()
          try {
            result = name.startsWith('mcp__') ? await broker.call(name, args) : await nativeCall(name, args, options)
          } catch (error) {
            if (options.abortController?.signal.aborted) throw error
            return `Tool error: ${error.message}`
          }
          for (const entry of options.hooks?.PostToolUse ?? []) {
            for (const hook of entry.hooks) await hook({ ...input, tool_response: result })
          }
          options.abortController?.signal.throwIfAborted()
          toolCalls++
          if (name === 'mcp__agent__report' && ['done', 'blocked'].includes(args.status) && !result.startsWith('Tool error:')) reported = true
          return result
        },
      })
      if (!toolCalls) throw new Error('The scheduled model finished without using its required tools. Choose a model with function-tool support.')
      yield { type: 'result', subtype: 'success' }
    } finally {
      await broker.close()
    }
  }
}