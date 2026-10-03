import OpenAI from 'openai'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { tmpdir } from 'node:os'

/**
 * Turns an image or scanned PDF into text for a model that cannot see, using
 * whichever vision-capable provider is reachable. The result is cached on the
 * file so a retry or failover does not pay for it twice.
 */

const instruction = (file) =>
  `The attached ${file.kind === 'pdf' ? 'PDF' : 'image'} "${file.name}" will be handed to a model that cannot see it. ` +
  'Transcribe all visible text exactly, then describe everything else in enough detail for that model to answer ' +
  'questions about it. Reply with the transcription and description only.'

async function viaClaude(file, model) {
  const source = { type: 'base64', media_type: file.mimeType, data: file.data }
  const block = file.kind === 'pdf' ? { type: 'document', source } : { type: 'image', source }
  async function* once() {
    yield { type: 'user', message: { role: 'user', content: [block, { type: 'text', text: instruction(file) }] }, parent_tool_use_id: null }
  }
  const options = { model, tools: [], settingSources: [], maxTurns: 1, persistSession: false, cwd: tmpdir() }
  for await (const msg of query({ prompt: once(), options })) {
    if (msg.type !== 'result') continue
    if (msg.subtype === 'success' && msg.result) return msg.result
    throw new Error(msg.subtype)
  }
  throw new Error('no answer')
}

async function viaOpenAI(file, env) {
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY, maxRetries: 1 })
  const url = `data:${file.mimeType};base64,${file.data}`
  const part = file.kind === 'pdf'
    ? { type: 'file', file: { filename: file.name, file_data: url } }
    : { type: 'image_url', image_url: { url } }
  const response = await client.chat.completions.create({
    model: env.OPENAI_MODEL || 'gpt-4.1-mini',
    messages: [{ role: 'user', content: [part, { type: 'text', text: instruction(file) }] }],
  })
  const text = response.choices[0]?.message?.content
  if (!text) throw new Error('no answer')
  return text
}

/**
 * @param {object} file  A parsed image or PDF attachment.
 * @param {{ available: string[], exclude?: string, env?: object, claudeModel?: string }} options
 *   `exclude` is the provider that just refused the file, so it is not asked again.
 */
export async function describeFile(file, { available, exclude, env = process.env, claudeModel = 'haiku' }) {
  if (file.description) return file.description
  const readers = [
    ['Claude', 'claude', () => viaClaude(file, claudeModel)],
    ['OpenAI', 'openai', () => viaOpenAI(file, env)],
  ].filter(([, id]) => id !== exclude && available.includes(id))
  const failures = []
  for (const [name, , read] of readers) {
    try {
      file.description = { by: name, text: await read() }
      return file.description
    } catch (err) {
      failures.push(`${name}: ${err?.message ?? err}`)
    }
  }
  throw new Error(`Could not read ${file.name}: ${failures.length ? failures.join('; ') : 'no vision-capable provider is configured'}.`)
}
