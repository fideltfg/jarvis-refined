import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { configuredProviders, fallbackProvider, isCapacityError, providerModels, resolveModel, retryProvider, textProvider } from './providers.mjs'
import { loadEnvFile } from './env.mjs'

test('shared provider environment loading preserves explicit settings and file precedence', () => {
  const env = { OPENAI_MODEL: 'explicit-model' }
  loadEnvFile('project', { env, readFile: () => 'export OPENAI_API_KEY="fixture-key"\nOPENAI_MODEL=ignored\nJARVIS_OPENAI_MODELS=second-model\n# comment' })
  loadEnvFile('secrets', { env, readFile: () => "OPENAI_API_KEY='other-key'\nJARVIS_AGENTS_TOKEN='fixture-token'" })
  assert.deepEqual(env, { OPENAI_MODEL: 'explicit-model', OPENAI_API_KEY: 'fixture-key', JARVIS_OPENAI_MODELS: 'second-model', JARVIS_AGENTS_TOKEN: 'fixture-token' })
  loadEnvFile('missing', { env, readFile: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) } })
  assert.ok(configuredProviders(env).includes('openai'))
})

test('only capacity failures qualify for provider failover', () => {
  assert.equal(isCapacityError({ status: 429 }), true)
  assert.equal(isCapacityError({ code: 'insufficient_quota' }), true)
  assert.equal(isCapacityError({ errors: ['Credit balance is too low'] }), true)
  assert.equal(isCapacityError({ code: 'context_length_exceeded' }), true)
  assert.equal(isCapacityError({ status: 401, message: 'Invalid API key' }), false)
  assert.equal(isCapacityError({ message: 'tool failed' }), false)
})

test('fallback requires another configured provider', () => {
  assert.equal(fallbackProvider('claude', ['claude', 'openai']), 'openai')
  assert.equal(fallbackProvider('openai', ['claude', 'openai']), 'claude')
  assert.equal(fallbackProvider('claude', ['claude']), null)
  assert.equal(fallbackProvider('openai', ['claude', 'openai', 'local']), 'claude')
})

test('a turn can only retry capacity failures before any output or tools', () => {
  const available = ['claude', 'openai', 'local']
  assert.equal(retryProvider('claude', available, new Set(['claude']), { status: 429 }, false), 'openai')
  assert.equal(retryProvider('claude', available, new Set(['claude', 'openai']), { status: 429 }, false), 'local')
  assert.equal(retryProvider('claude', available, new Set(['claude']), { status: 429 }, true), null)
  assert.equal(retryProvider('claude', available, new Set(['claude']), { status: 401 }, false), null)
})

test('only configured providers are offered', () => {
  assert.deepEqual(configuredProviders({}), ['claude'])
  assert.deepEqual(configuredProviders({ OPENAI_API_KEY: 'key' }), ['claude', 'openai'])
  assert.deepEqual(configuredProviders({ JARVIS_LOCAL_URL: 'http://localhost:11434/v1', JARVIS_LOCAL_MODEL: 'model' }), ['claude', 'local'])
})

test('each configured provider offers its models, default first', () => {
  assert.deepEqual(providerModels({}, 'claude-opus-5'), { claude: ['claude-opus-5', 'opus', 'sonnet', 'haiku'] })
  assert.deepEqual(providerModels({ JARVIS_CLAUDE_MODELS: 'sonnet, opus' }, 'sonnet').claude, ['sonnet', 'opus'])
  assert.deepEqual(providerModels({ OPENAI_API_KEY: 'key', OPENAI_MODEL: 'a', JARVIS_OPENAI_MODELS: 'b,a' }).openai, ['a', 'b'])
  const endpoints = JSON.stringify([
    { id: 'one', kind: 'openai', baseURL: 'http://localhost:1/v1', model: 'small' },
    { id: 'two', kind: 'openai', baseURL: 'http://localhost:2/v1', model: 'big' },
  ])
  assert.deepEqual(providerModels({ JARVIS_ENDPOINTS: endpoints }).local, ['small', 'big'])
})

test('an unknown model falls back to the provider default', () => {
  const models = { claude: ['opus', 'sonnet'] }
  assert.equal(resolveModel(models, 'claude', 'sonnet'), 'sonnet')
  assert.equal(resolveModel(models, 'claude', 'gpt-9'), 'opus')
  assert.equal(resolveModel(models, 'local', 'x'), undefined)
})

test('choosing a local model routes the turn to the endpoint serving it', async () => {
  const hits = []
  const serve = (name) => createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      hits.push([name, JSON.parse(body).model])
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
    })
  })
  const servers = [serve('one'), serve('two')]
  await Promise.all(servers.map((server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))))
  try {
    const env = {
      JARVIS_ENDPOINTS: JSON.stringify(servers.map((server, index) => ({
        id: index ? 'two' : 'one',
        kind: 'openai',
        baseURL: `http://127.0.0.1:${server.address().port}/v1`,
        model: index ? 'big' : 'small',
      }))),
    }
    await textProvider('local', env, 'big')([{ role: 'user', content: 'Hi' }], new AbortController().signal, () => {})
    assert.deepEqual(hits, [['two', 'big']])
  } finally {
    servers.forEach((server) => server.close())
  }
})

test('local adapter streams OpenAI-compatible text without a real API key', async () => {
  const server = createServer((request, response) => {
    assert.equal(request.url, '/v1/chat/completions')
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n')
    response.write('data: {"choices":[{"delta":{"content":" there"}}]}\n\n')
    response.end('data: [DONE]\n\n')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const chunks = []
    const stream = textProvider('local', {
      JARVIS_LOCAL_URL: `http://127.0.0.1:${server.address().port}/v1`,
      JARVIS_LOCAL_MODEL: 'mock',
    })
    await stream([{ role: 'user', content: 'Hi' }], new AbortController().signal, (chunk) => chunks.push(chunk))
    assert.deepEqual(chunks, ['Hello', ' there'])
  } finally {
    server.close()
  }
})

test('local endpoints are never sent the OpenAI-only prompt cache key', async () => {
  let body
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    body = JSON.parse(raw)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: [DONE]\n\n')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const stream = textProvider({ id: 'mock', baseURL: `http://127.0.0.1:${server.address().port}/v1`, model: 'mock' })
    await stream([{ role: 'user', content: 'Hi' }], new AbortController().signal, () => {}, { cacheKey: 'jarvis-stark' })
    assert.equal(body.prompt_cache_key, undefined)
  } finally {
    server.close()
  }
})

test('a provider HTTP 429 is classified for failover', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(429, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'Quota exceeded', type: 'insufficient_quota' } }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const stream = textProvider('local', {
      JARVIS_LOCAL_URL: `http://127.0.0.1:${server.address().port}/v1`,
      JARVIS_LOCAL_MODEL: 'mock',
    })
    await assert.rejects(
      stream([{ role: 'user', content: 'Hi' }], new AbortController().signal, () => {}),
      (error) => isCapacityError(error),
    )
  } finally {
    server.close()
  }
})

test('a temporary 429 after a tool call retries without calling the tool twice', async () => {
  let requests = 0
  let calls = 0
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume the request body */ }
    requests += 1
    if (requests === 2) {
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after-ms': '1' })
      response.end(JSON.stringify({ error: { message: 'Rate limit reached', type: 'tokens' } }))
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message: requests === 1
      ? { role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'test_tool', arguments: '{}' } }] }
      : { role: 'assistant', content: 'Done.' } }] }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const chunks = []
    const stream = textProvider({ id: 'mock', baseURL: `http://127.0.0.1:${server.address().port}/v1`, model: 'mock' })
    await stream([{ role: 'user', content: 'test' }], new AbortController().signal, (text) => chunks.push(text), {
      tools: [{ type: 'function', function: { name: 'test_tool', parameters: { type: 'object' } } }],
      callTool: async () => { calls += 1; return 'ok' },
    })
    assert.equal(requests, 3)
    assert.equal(calls, 1)
    assert.deepEqual(chunks, ['Done.'])
  } finally {
    server.close()
  }
})

test('the last tool round requests a tool-free progress summary', async () => {
  let requests = 0
  const server = createServer(async (request, response) => {
    const parts = []
    for await (const part of request) parts.push(part)
    const body = JSON.parse(Buffer.concat(parts).toString())
    requests += 1
    if (requests === 12) {
      assert.equal(body.tools, undefined)
      assert.match(body.messages.at(-1).content, /Summarize what was completed/)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: {"choices":[{"delta":{"content":"Work remains."}}]}\n\ndata: [DONE]\n\n')
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: `call-${requests}`, type: 'function', function: { name: 'test_tool', arguments: '{}' } }] } }] }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const chunks = []
    const stream = textProvider({ id: 'mock', baseURL: `http://127.0.0.1:${server.address().port}/v1`, model: 'mock' })
    await stream([{ role: 'user', content: 'test' }], new AbortController().signal, (text) => chunks.push(text), {
      tools: [{ type: 'function', function: { name: 'test_tool', parameters: { type: 'object' } } }],
      callTool: async () => 'ok',
    })
    assert.equal(requests, 12)
    assert.deepEqual(chunks, ['Work remains.'])
  } finally {
    server.close()
  }
})