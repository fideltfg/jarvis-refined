import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { configuredProviders, fallbackProvider, isCapacityError, retryProvider, textProvider } from './providers.mjs'

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