import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createHealth,
  endpointKey,
  endpointsFor,
  getEndpoint,
  listEndpoints,
  parseEndpoints,
  probeEndpoint,
} from './endpoints.mjs'

/** Collects the warnings instead of printing them, so a run stays readable. */
function warnings() {
  const lines = []
  return { warn: (line) => lines.push(line), lines }
}

const three = [
  { id: 'cloud', kind: 'anthropic', concurrency: 3 },
  { id: 'rigel', kind: 'gateway', baseURL: 'http://11.0.0.9:4000/', model: 'llama3.1:8b', concurrency: 2 },
  { id: 'cupboard', kind: 'openai', baseURL: 'http://11.0.0.12:11434/v1', model: 'qwen2.5:3b', kinds: ['research'] },
]

// -- parsing ----------------------------------------------------------------

test('an array is taken as it stands, with the documented defaults filled in', () => {
  const [one] = parseEndpoints([{ id: 'rigel', kind: 'openai', baseURL: 'http://x/v1', model: 'm' }])
  assert.deepEqual(one, {
    id: 'rigel',
    kind: 'openai',
    baseURL: 'http://x/v1',
    model: 'm',
    apiKeyEnv: null,
    concurrency: 1,
    kinds: [],
    weight: 1,
    label: 'rigel',
  })
})

test('a JSON string parses, and trailing slashes come off the base URL', () => {
  const list = parseEndpoints(JSON.stringify(three))
  assert.deepEqual(list.map((e) => e.id), ['cloud', 'rigel', 'cupboard'])
  assert.equal(list[1].baseURL, 'http://11.0.0.9:4000')
})

test('a path is read as a file holding the list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-endpoints-'))
  const file = join(dir, 'endpoints.json')
  writeFileSync(file, JSON.stringify(three))
  assert.deepEqual(parseEndpoints(file).map((e) => e.id), ['cloud', 'rigel', 'cupboard'])
})

test('a path that cannot be read is said out loud rather than ignored', () => {
  assert.throws(() => parseEndpoints(join(tmpdir(), 'jarvis-no-such-endpoints.json')), /could not be read/)
})

test('something that is not an array at all is refused', () => {
  assert.throws(() => parseEndpoints('{"id":"rigel"}'), /must be a JSON array/)
})

test('an empty or blank setting is simply no endpoints', () => {
  assert.deepEqual(parseEndpoints(''), [])
  assert.deepEqual(parseEndpoints('   '), [])
})

test('anthropic needs no base URL; everything else does', () => {
  const w = warnings()
  const list = parseEndpoints([
    { id: 'cloud', kind: 'anthropic' },
    { id: 'nowhere', kind: 'gateway' },
  ], w)
  assert.deepEqual(list.map((e) => e.id), ['cloud'])
  assert.match(w.lines.join('\n'), /"nowhere" needs a baseURL/)
})

test('concurrency is a whole number of at least one, however it was written', () => {
  const list = parseEndpoints([
    { id: 'a', baseURL: 'http://a/v1', model: 'm', concurrency: 0 },
    { id: 'b', baseURL: 'http://b/v1', model: 'm', concurrency: -4 },
    { id: 'c', baseURL: 'http://c/v1', model: 'm', concurrency: '2.7' },
    { id: 'd', baseURL: 'http://d/v1', model: 'm', concurrency: 'plenty' },
  ])
  assert.deepEqual(list.map((e) => e.concurrency), [1, 1, 2, 1])
})

// -- bad entries ------------------------------------------------------------

test('one bad entry costs only itself', () => {
  const w = warnings()
  const list = parseEndpoints([
    three[0],
    null,
    'rigel',
    { kind: 'openai', baseURL: 'http://x/v1', model: 'm' },
    { id: 'odd', kind: 'telepathy', baseURL: 'http://x/v1' },
    { id: 'modelless', kind: 'openai', baseURL: 'http://x/v1' },
    three[1],
  ], w)
  assert.deepEqual(list.map((e) => e.id), ['cloud', 'rigel'])
  assert.equal(w.lines.length, 5)
  assert.match(w.lines.join('\n'), /is not an object/)
  assert.match(w.lines.join('\n'), /has no id/)
  assert.match(w.lines.join('\n'), /use one of anthropic, openai, gateway/)
  assert.match(w.lines.join('\n'), /"modelless" needs a model/)
})

test('a duplicate id is dropped and the first one stands', () => {
  const w = warnings()
  const list = parseEndpoints([
    { id: 'rigel', baseURL: 'http://first/v1', model: 'm' },
    { id: 'rigel', baseURL: 'http://second/v1', model: 'm' },
  ], w)
  assert.equal(list.length, 1)
  assert.equal(list[0].baseURL, 'http://first/v1')
  assert.match(w.lines.join('\n'), /declared twice/)
})

// -- the environment --------------------------------------------------------

test('the list is read from the environment, by id and by filter', () => {
  const env = { JARVIS_ENDPOINTS: JSON.stringify(three) }
  assert.equal(listEndpoints(env).length, 3)
  assert.equal(getEndpoint('rigel', env).model, 'llama3.1:8b')
  assert.equal(getEndpoint('nobody', env), null)
  assert.deepEqual(endpointsFor({ kind: 'gateway' }, env).map((e) => e.id), ['rigel'])
  assert.deepEqual(endpointsFor({ taskKind: 'code' }, env).map((e) => e.id), ['cloud', 'rigel'])
  assert.deepEqual(endpointsFor({ taskKind: 'research' }, env).map((e) => e.id), ['cloud', 'rigel', 'cupboard'])
})

test('the old single-model variables still describe one endpoint', () => {
  const env = { JARVIS_LOCAL_URL: 'http://11.0.0.163:11434/v1/', JARVIS_LOCAL_MODEL: 'llama3.1:8b' }
  const [local] = listEndpoints(env)
  assert.equal(local.id, 'local')
  assert.equal(local.kind, 'openai')
  assert.equal(local.baseURL, 'http://11.0.0.163:11434/v1')
  assert.equal(local.apiKeyEnv, null)
  assert.deepEqual(listEndpoints({}), [])
})

test('a declared list wins over the old variables', () => {
  const env = {
    JARVIS_ENDPOINTS: JSON.stringify([three[1]]),
    JARVIS_LOCAL_URL: 'http://old/v1',
    JARVIS_LOCAL_MODEL: 'old',
  }
  assert.deepEqual(listEndpoints(env).map((e) => e.id), ['rigel'])
})

test('a key is named by variable, never carried in the list', () => {
  const env = { RIGEL_KEY: 'sk-rigel', ANTHROPIC_API_KEY: 'sk-cloud', JARVIS_LOCAL_API_KEY: 'sk-local' }
  const [rigel] = parseEndpoints([{ ...three[1], apiKeyEnv: 'RIGEL_KEY' }])
  assert.equal(endpointKey(rigel, env), 'sk-rigel')
  assert.equal(endpointKey(parseEndpoints([three[0]])[0], env), 'sk-cloud')
  assert.equal(endpointKey(parseEndpoints([{ id: 'local', baseURL: 'http://l/v1', model: 'm' }])[0], env), 'sk-local')
  assert.equal(endpointKey(parseEndpoints([three[2]])[0], env), null)
  assert.equal(endpointKey(null, env), null)
})

// -- probing ----------------------------------------------------------------

test('an endpoint with no base URL is reachable by definition', async () => {
  assert.equal(await probeEndpoint({ id: 'cloud', kind: 'anthropic', baseURL: null }), true)
})

test('the probe asks for the model list, carrying the key when there is one', async () => {
  const calls = []
  const endpoint = parseEndpoints([{ ...three[1], apiKeyEnv: 'RIGEL_KEY' }])[0]
  const fetchFn = async (url, init) => {
    calls.push([url, init.headers])
    return { ok: true, status: 200 }
  }
  assert.equal(await probeEndpoint(endpoint, { fetchFn, env: { RIGEL_KEY: 'sk-rigel' } }), true)
  assert.deepEqual(calls, [['http://11.0.0.9:4000/v1/models', { authorization: 'Bearer sk-rigel' }]])
})

test('a gateway is probed under /v1, an openai endpoint at its own base', async () => {
  const calls = []
  const fetchFn = async (url) => {
    calls.push(url)
    return { ok: true, status: 200 }
  }
  // A gateway base URL is what ANTHROPIC_BASE_URL wants — no version segment —
  // so probing it verbatim would ask the root for a model list and read as dead.
  for (const endpoint of parseEndpoints([three[1], three[2]])) {
    await probeEndpoint(endpoint, { fetchFn, env: {} })
  }
  assert.deepEqual(calls, ['http://11.0.0.9:4000/v1/models', 'http://11.0.0.12:11434/v1/models'])
})

test('a wrong key is a configuration fault, not a dead host', async () => {
  const endpoint = parseEndpoints([three[1]])[0]
  for (const status of [401, 403]) {
    assert.equal(await probeEndpoint(endpoint, { fetchFn: async () => ({ ok: false, status }), env: {} }), true)
  }
  assert.equal(await probeEndpoint(endpoint, { fetchFn: async () => ({ ok: false, status: 500 }), env: {} }), false)
})

test('a host that refuses or hangs is unhealthy rather than thrown', async () => {
  const endpoint = parseEndpoints([three[1]])[0]
  const dead = async () => { throw new Error('ECONNREFUSED') }
  assert.equal(await probeEndpoint(endpoint, { fetchFn: dead, env: {} }), false)

  const hangs = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')))
  })
  assert.equal(await probeEndpoint(endpoint, { fetchFn: hangs, timeoutMs: 5, env: {} }), false)
})

// -- health, and its memory -------------------------------------------------

test('unprobed is healthy, so a fresh start never waits to begin', () => {
  const health = createHealth({ probe: async () => false })
  assert.equal(health.healthy('rigel'), true)
  assert.deepEqual(health.snapshot(), [])
})

test('a verdict is cached for the time to live, then taken again', async () => {
  let clock = 1000
  let probes = 0
  const health = createHealth({
    ttlMs: 60_000,
    now: () => clock,
    probe: async () => { probes += 1; return probes > 1 },
  })
  const endpoint = parseEndpoints([three[1]])[0]

  assert.equal(await health.check(endpoint), false)
  assert.equal(probes, 1)

  clock += 59_999
  assert.equal(await health.check(endpoint), false)
  assert.equal(probes, 1, 'inside the window nothing waits on a dead host twice')

  clock += 2
  assert.equal(await health.check(endpoint), true)
  assert.equal(probes, 2)
  assert.equal(health.healthy('rigel'), true)
})

test('a forced check ignores the cache', async () => {
  let probes = 0
  const health = createHealth({ now: () => 0, probe: async () => { probes += 1; return true } })
  const endpoint = parseEndpoints([three[1]])[0]
  await health.check(endpoint)
  await health.check(endpoint)
  assert.equal(probes, 1)
  await health.check(endpoint, { force: true })
  assert.equal(probes, 2)
})

test('a verdict can be marked by hand, as a failed run does', () => {
  const health = createHealth({ now: () => 7 })
  health.mark('rigel', false)
  assert.equal(health.healthy('rigel'), false)
  assert.deepEqual(health.snapshot(), [{ id: 'rigel', healthy: false, checked: 7 }])
  health.mark('rigel', true)
  assert.equal(health.healthy('rigel'), true)
})

test('checking the lot returns only the ones that answered', async () => {
  const list = parseEndpoints(three)
  const health = createHealth({ now: () => 0, probe: async (endpoint) => endpoint.id !== 'cupboard' })
  const alive = await health.checkAll(list)
  assert.deepEqual(alive.map((e) => e.id), ['cloud', 'rigel'])
  assert.equal(health.snapshot().length, 3)
})
