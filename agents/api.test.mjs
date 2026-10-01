import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from './store.mjs'
import { createApprovals } from './approvals.mjs'
import { createApi } from './api.mjs'
import { boardOf, briefing } from './briefing.mjs'
import { createPool } from './pool.mjs'
import { parseEndpoints } from '../bridge/endpoints.mjs'

const TOKEN = 'test-token'

async function setup({ pool = null } = {}) {
  const store = createStore(mkdtempSync(join(tmpdir(), 'agents-api-')), { workDir: '/work' })
  const approvals = createApprovals(store)
  const calls = { plan: [], redirect: [], cancel: [], mirror: [] }
  const api = createApi({
    store,
    approvals,
    pool,
    token: TOKEN,
    scheduler: { running: () => new Set(), cancel: (id) => { calls.cancel.push(id); return true } },
    coordinator: {
      plan: async (id) => { calls.plan.push(id) },
      redirect: async (id, text) => { calls.redirect.push([id, text]) },
    },
    cleanup: () => ['t_1'],
    mirror: { goalCreated: (g) => calls.mirror.push(g.id) },
  })
  const port = await api.listen()
  const base = `http://127.0.0.1:${port}`
  const call = (method, path, body, token = TOKEN) =>
    fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
  return { store, approvals, api, base, call, calls }
}

test('the API refuses to start without a token', () => {
  assert.throws(() => createApi({ token: '' }), /JARVIS_AGENTS_TOKEN/)
})

test('requests without the token are rejected', async () => {
  const s = await setup()
  try {
    assert.equal((await s.call('GET', '/board', null, 'wrong')).status, 401)
    assert.equal((await fetch(`${s.base}/board`)).status, 401)
  } finally {
    await s.api.close()
  }
})

test('creating a goal saves it, mirrors it and asks the coordinator to plan', async () => {
  const s = await setup()
  try {
    const res = await s.call('POST', '/goals', { title: 'Research bounties', outcome: 'A report' })
    assert.equal(res.status, 201)
    const goal = await res.json()
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(s.calls.plan, [goal.id])
    assert.deepEqual(s.calls.mirror, [goal.id])
    const board = await (await s.call('GET', '/board')).json()
    assert.equal(board.goals[0].title, 'Research bounties')
    assert.equal((await s.call('POST', '/goals', { title: 'no outcome' })).status, 400)
    assert.equal((await s.call('POST', '/goals', { title: 'x', outcome: 'y', recurring: { every: 'often' } })).status, 400)
  } finally {
    await s.api.close()
  }
})

test('goal changes: pause, resume, abandon and new information', async () => {
  const s = await setup()
  try {
    const g = s.store.newGoal({ title: 'G', outcome: 'O' })
    const t = s.store.newTask({ goalId: g.id, title: 'T', brief: 'b' })
    assert.equal((await (await s.call('POST', `/goals/${g.id}`, { action: 'pause' })).json()).status, 'paused')
    assert.equal((await (await s.call('POST', `/goals/${g.id}`, { action: 'resume' })).json()).status, 'active')
    await s.call('POST', `/goals/${g.id}`, { info: 'Use the beta branch' })
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(s.calls.redirect.at(-1), [g.id, 'Use the beta branch'])
    assert.equal((await (await s.call('POST', `/goals/${g.id}`, { action: 'abandon' })).json()).status, 'abandoned')
    assert.deepEqual(s.calls.cancel, [t.id])
    assert.equal((await s.call('POST', `/goals/${g.id}`, { action: 'explode' })).status, 400)
    assert.equal((await s.call('POST', '/goals/g_missing', { action: 'pause' })).status, 404)
  } finally {
    await s.api.close()
  }
})

test('approvals can be listed and decided; a bad decision is a 400', async () => {
  const s = await setup()
  try {
    const g = s.store.newGoal({ title: 'G', outcome: 'O' })
    const task = s.store.newTask({ goalId: g.id, title: 'T', brief: 'b' })
    const waiting = s.approvals.request({ task, category: 'money', action: 'pay', detail: 'x' })
    const [a] = await (await s.call('GET', '/approvals')).json()
    assert.equal((await s.call('POST', `/approvals/${a.id}`, { decision: 'maybe' })).status, 400)
    assert.equal((await s.call('POST', `/approvals/${a.id}`, { decision: 'approve' })).status, 200)
    assert.deepEqual(await waiting, { approved: true, note: null })
    assert.equal((await s.call('POST', `/approvals/${a.id}`, { decision: 'deny' })).status, 400)
  } finally {
    await s.api.close()
  }
})

test('status, cancel and cleanup routes', async () => {
  const s = await setup()
  try {
    s.store.newGoal({ title: 'Ship it', outcome: 'O' })
    const { text } = await (await s.call('GET', '/status')).json()
    assert.match(text, /Ship it/)
    assert.equal((await s.call('POST', '/tasks/t_1/cancel')).status, 200)
    assert.deepEqual(await (await s.call('POST', '/cleanup')).json(), { removed: ['t_1'] })
    assert.equal((await s.call('GET', '/nowhere')).status, 404)
  } finally {
    await s.api.close()
  }
})

test('the event stream delivers new events', async () => {
  const s = await setup()
  try {
    const controller = new AbortController()
    const res = await fetch(`${s.base}/events`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: controller.signal })
    assert.equal(res.headers.get('content-type'), 'text/event-stream')
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    s.store.appendEvent({ type: 'goal_done', text: 'Goal complete: X' })
    let buf = ''
    while (!buf.includes('goal_done')) buf += decoder.decode((await reader.read()).value)
    assert.match(buf, /data: \{.*"type":"goal_done"/)
    controller.abort()
  } finally {
    await s.api.close()
  }
})

test('the server listens on loopback only', async () => {
  const s = await setup()
  try {
    const port = Number(new URL(s.base).port)
    await assert.rejects(fetch(`http://[::1]:${port}/board`))
  } finally {
    await s.api.close()
  }
})

test('the briefing is short and speakable', () => {
  const store = createStore(mkdtempSync(join(tmpdir(), 'agents-brief-')), { workDir: '/work' })
  assert.equal(briefing(store), 'No agent work is in progress.')
  const g = store.newGoal({ title: 'Release stealthDash', outcome: 'Tagged' })
  const a = store.newTask({ goalId: g.id, title: 'CI', brief: 'b' })
  store.newTask({ goalId: g.id, title: 'Notes', brief: 'b' })
  store.saveTask({ ...a, status: 'done' })
  assert.equal(briefing(store), 'One goal in progress. Release stealthDash: 1 of 2 tasks done, 1 queued.')
  assert.match(briefing(store, g.id), /Release stealthDash\. Done means: Tagged\./)
  const board = boardOf(store, new Set([a.id]))
  assert.deepEqual(board.running, [a.id])
  assert.equal(board.goals[0].tasks.length, 2)
})

test('F11: the board leaves out archived tasks', () => {
  const store = createStore(mkdtempSync(join(tmpdir(), 'agents-board11-')), { workDir: '/work' })
  const g = store.newGoal({ title: 'G', outcome: 'O' })
  store.saveTask({ ...store.newTask({ goalId: g.id, title: 'Old', brief: 'b' }), status: 'done', archived: true })
  store.newTask({ goalId: g.id, title: 'New', brief: 'b' })
  assert.deepEqual(boardOf(store).goals[0].tasks.map((t) => t.title), ['New'])
})

// -- the capacity readout ---------------------------------------------------

test('GET /endpoints reports the pool, its width and what is busy', async () => {
  const pool = createPool({
    endpoints: parseEndpoints([
      { id: 'cloud', kind: 'anthropic', concurrency: 2 },
      { id: 'rigel', kind: 'gateway', baseURL: 'http://11.0.0.9:4000', model: 'llama3.1:8b', apiKeyEnv: 'RIGEL_KEY' },
    ]),
  })
  pool.acquire({ model: 'rigel' })
  const s = await setup({ pool })
  try {
    const res = await s.call('GET', '/endpoints')
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.capacity, 3)
    assert.equal(body.running, 1)
    assert.deepEqual(body.endpoints.map((e) => [e.id, e.running, e.concurrency]), [['cloud', 0, 2], ['rigel', 1, 1]])
    // No addresses and no key names go out of the process.
    assert.doesNotMatch(JSON.stringify(body), /11\.0\.0\.9|RIGEL_KEY/)
  } finally {
    await s.api.close()
  }
})

test('with no pool configured the readout still answers, from the running set', async () => {
  const s = await setup()
  try {
    const body = await (await s.call('GET', '/endpoints')).json()
    assert.deepEqual(body, { capacity: null, running: 0, endpoints: [] })
  } finally {
    await s.api.close()
  }
})
