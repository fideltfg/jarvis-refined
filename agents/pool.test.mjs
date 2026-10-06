import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseEndpoints } from '../bridge/endpoints.mjs'
import { MAX_WORKERS } from './config.mjs'
import { agentEndpoints, createPool, isTaskModel, taskModels } from './pool.mjs'

const envWith = (list) => ({ JARVIS_ENDPOINTS: JSON.stringify(list) })

const CLOUD = { id: 'cloud', kind: 'anthropic', concurrency: 2 }
const RIGEL = { id: 'rigel', kind: 'gateway', baseURL: 'http://11.0.0.9:4000', model: 'llama3.1:8b', concurrency: 2 }
const SHELF = { id: 'shelf', kind: 'gateway', baseURL: 'http://11.0.0.12:4000', model: 'qwen2.5:3b', kinds: ['research'] }
const OLLAMA = { id: 'ollama', kind: 'openai', baseURL: 'http://11.0.0.163:11434/v1', model: 'llama3.1:8b', concurrency: 4 }

const pool = (list, options = {}) => createPool({ endpoints: parseEndpoints(list), ...options })

// -- which endpoints can carry a task ---------------------------------------

test('with nothing declared, the pool is the Anthropic API at the old width', () => {
  const [only] = agentEndpoints({})
  assert.equal(only.id, 'anthropic')
  assert.equal(only.kind, 'anthropic')
  assert.equal(only.concurrency, MAX_WORKERS)
})

test('an OpenAI-compatible box cannot carry a task, because the gate lives in the SDK', () => {
  assert.deepEqual(agentEndpoints(envWith([OLLAMA])).map((e) => e.id), ['anthropic'])
  assert.deepEqual(agentEndpoints(envWith([CLOUD, OLLAMA, RIGEL])).map((e) => e.id), ['cloud', 'rigel'])
})

test('a task may name a size or a declared endpoint, and nothing else', () => {
  const env = envWith([CLOUD, RIGEL, OLLAMA])
  assert.equal(isTaskModel('sonnet', env), true)
  assert.equal(isTaskModel('opus', env), true)
  assert.equal(isTaskModel('rigel', env), true)
  assert.equal(isTaskModel('ollama', env), false)
  assert.equal(isTaskModel('rigel-ish', env), false)
  assert.equal(isTaskModel('', env), false)
  assert.equal(isTaskModel(undefined, env), false)
  assert.deepEqual(taskModels(env), ['sonnet', 'opus', 'cloud', 'rigel'])
})

// -- leases, per endpoint ---------------------------------------------------

test('capacity is the endpoints added up, and the ceiling caps it', () => {
  assert.equal(pool([CLOUD, RIGEL, SHELF]).capacity(), 5)
  assert.equal(pool([CLOUD, RIGEL, SHELF], { maxTotal: 3 }).capacity(), 3)
})

test('an endpoint hands out exactly its own concurrency', () => {
  const p = pool([RIGEL])
  const task = { model: 'rigel' }
  const first = p.acquire(task)
  const second = p.acquire(task)
  assert.equal(first.endpoint.id, 'rigel')
  assert.equal(second.endpoint.id, 'rigel')
  assert.equal(p.inFlight(), 2)
  assert.equal(p.acquire(task), null, 'a third is refused while two are out')
  assert.equal(p.free(), false)

  first.release()
  assert.equal(p.inFlight(), 1)
  assert.equal(p.free(), true)
  assert.ok(p.acquire(task))
})

test('releasing twice gives back one lease, not two', () => {
  const p = pool([SHELF])
  const task = { model: 'shelf', kind: 'research' }
  const lease = p.acquire(task)
  lease.release()
  lease.release()
  assert.equal(p.inFlight(), 0)
  assert.ok(p.acquire(task))
  assert.equal(p.acquire(task), null)
})

test('four boxes at two jobs each carry eight tasks', () => {
  const boxes = [1, 2, 3, 4].map((n) => ({
    id: `box${n}`, kind: 'gateway', baseURL: `http://11.0.0.${n}:4000`, model: 'llama3.1:8b', concurrency: 2,
  }))
  const p = pool(boxes)
  assert.equal(p.capacity(), 8)
  // Each task names the box it wants; an unpinned task is a Claude size and
  // would go to Anthropic instead.
  const leases = boxes.flatMap((box) => [p.acquire({ model: box.id }), p.acquire({ model: box.id })])
  assert.ok(leases.every(Boolean))
  assert.equal(p.acquire({ model: 'box1' }), null)
  assert.deepEqual(p.snapshot().map((e) => e.running), [2, 2, 2, 2], 'the work is spread, not stacked')
})

test('work goes to the box with the most room left, in proportion to its size', () => {
  // Two Anthropic entries — two accounts, say — so an unpinned task may land on
  // either and the ordering is what decides.
  const p = pool([
    { id: 'wide', kind: 'anthropic', concurrency: 4 },
    { id: 'narrow', kind: 'anthropic', concurrency: 1 },
  ])
  assert.equal(p.acquire().endpoint.id, 'narrow', 'both are empty, so the tie falls to the name')
  assert.equal(p.acquire().endpoint.id, 'wide', 'narrow is now full in its own terms')
  assert.equal(p.acquire().endpoint.id, 'wide')
  assert.equal(p.acquire().endpoint.id, 'wide')
  assert.equal(p.acquire().endpoint.id, 'wide')
  assert.equal(p.acquire(), null)
})

test('a tie is broken by weight, then by id, so a test twice is a test the same', () => {
  const p = pool([
    { id: 'alpha', kind: 'anthropic', concurrency: 1, weight: 1 },
    { id: 'bravo', kind: 'anthropic', concurrency: 1, weight: 5 },
  ])
  assert.equal(p.acquire().endpoint.id, 'bravo', 'weight outranks the name')

  const even = pool([
    { id: 'bravo', kind: 'anthropic', concurrency: 1 },
    { id: 'alpha', kind: 'anthropic', concurrency: 1 },
  ])
  assert.equal(even.acquire().endpoint.id, 'alpha', 'and with equal weight the name decides')
})

// -- the global ceiling -----------------------------------------------------

test('the ceiling holds even when the endpoints could take more', () => {
  const p = pool([CLOUD, RIGEL, SHELF], { maxTotal: 2 })
  assert.ok(p.acquire())
  assert.ok(p.acquire())
  assert.equal(p.inFlight(), 2)
  assert.equal(p.free(), false)
  assert.equal(p.acquire(), null)
  assert.equal(p.snapshot().reduce((t, e) => t + e.running, 0), 2)
})

// -- pinning ----------------------------------------------------------------

test('a task pinned to a size runs on Anthropic, never on a gateway', () => {
  const p = pool([CLOUD, RIGEL])
  assert.equal(p.acquire({ model: 'opus' }).endpoint.id, 'cloud')
  assert.equal(p.acquire({ model: 'sonnet' }).endpoint.id, 'cloud')
  assert.equal(p.acquire({ model: 'sonnet' }), null, 'cloud is full and a size will not go local')
  assert.equal(p.acquire({ model: 'rigel' }).endpoint.id, 'rigel')
})

test('a task with no model at all takes Anthropic, as it always did', () => {
  assert.equal(pool([RIGEL, CLOUD]).acquire({}).endpoint.id, 'cloud')
  assert.equal(pool([RIGEL]).acquire({}), null)
})

test('a busy pin refuses that task while the pool still has room for another', () => {
  const p = pool([CLOUD, RIGEL])
  const held = [p.acquire({ model: 'rigel' }), p.acquire({ model: 'rigel' })]
  assert.ok(held.every(Boolean))
  assert.equal(p.acquire({ model: 'rigel' }), null)
  assert.equal(p.free(), true, 'so the scheduler looks at the next task instead of stopping')
  assert.equal(p.acquire({ model: 'sonnet' }).endpoint.id, 'cloud')
})

test('an endpoint that names task kinds takes only those', () => {
  const p = pool([SHELF])
  assert.equal(p.acquire({ model: 'shelf', kind: 'research' }).endpoint.id, 'shelf')
  assert.equal(p.acquire({ model: 'shelf', kind: 'code' }), null)
})

test('an endpoint naming no kinds takes anything', () => {
  const p = pool([RIGEL])
  assert.ok(p.acquire({ model: 'rigel', kind: 'code' }))
  assert.ok(p.acquire({ model: 'rigel', kind: 'admin' }))
})

test('marketing tasks stay on a local tool-enabled endpoint', () => {
  const endpoints = [
    { id: 'remote', kind: 'remote', concurrency: 1, kinds: [], weight: 1 },
    { ...CLOUD, kinds: [], weight: 1 },
  ]
  assert.equal(createPool({ endpoints }).acquire({ kind: 'marketing' }).endpoint.id, 'cloud')
  assert.equal(createPool({ endpoints: [endpoints[0]] }).acquire({ kind: 'marketing' }), null)
})

// -- health -----------------------------------------------------------------

test('an unhealthy endpoint is skipped and reported as such', () => {
  const health = { healthy: (id) => id !== 'rigel' }
  const p = pool([RIGEL, SHELF], { health })
  assert.equal(p.acquire({ model: 'rigel' }), null)
  assert.equal(p.acquire({ model: 'shelf', kind: 'research' }).endpoint.id, 'shelf')
  assert.deepEqual(p.snapshot().map((e) => [e.id, e.healthy]), [['rigel', false], ['shelf', true]])
})

test('every endpoint being down leaves the pool with no room at all', () => {
  const p = pool([RIGEL, SHELF], { health: { healthy: () => false } })
  assert.equal(p.free(), false)
  assert.equal(p.acquire(), null)
  assert.equal(p.capacity(), 3, 'capacity is what was declared, not what is answering')
})

// -- what the board sees ----------------------------------------------------

test('the readout names each endpoint, its load and its width', () => {
  const p = pool([RIGEL, SHELF])
  p.acquire({ model: 'rigel' })
  assert.deepEqual(p.snapshot(), [
    { id: 'rigel', label: 'rigel', kind: 'gateway', model: 'llama3.1:8b', healthy: true, running: 1, concurrency: 2, kinds: [] },
    { id: 'shelf', label: 'shelf', kind: 'gateway', model: 'qwen2.5:3b', healthy: true, running: 0, concurrency: 1, kinds: ['research'] },
  ])
})

test('the endpoint list is handed out as copies, so nothing outside can retune the pool', () => {
  const p = pool([RIGEL])
  const [copy] = p.endpoints()
  copy.concurrency = 99
  assert.equal(p.capacity(), 2)
})
