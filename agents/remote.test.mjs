import { test } from 'node:test'
import assert from 'node:assert/strict'

import { hostLabel, remoteModel, runRemoteTask } from './remote.mjs'
import { createPool } from './pool.mjs'
import { localModelURL, runTask as runLocalTask } from '../remote-runtime/worker.mjs'

/**
 * A task that runs on another machine, with that machine replaced by a script
 * of answers. What is being checked is the contract with the other host — what
 * is posted, what is polled, what is said when it stops answering — and the
 * two promises this file makes the user: work is never run twice, and a cancel
 * here is a cancel there.
 */

const ENDPOINT = {
  id: 'rigel',
  kind: 'remote',
  baseURL: 'https://rigel.lan:8788',
  model: null,
  apiKeyEnv: 'RIGEL_TOKEN',
  concurrency: 2,
  kinds: ['research', 'ops'],
  weight: 1,
  label: 'rigel',
}

const ENV = { RIGEL_TOKEN: 'shared-secret' }

test('remote inference only accepts numeric loopback OpenAI-compatible URLs', () => {
  assert.equal(localModelURL('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1')
  assert.throws(() => localModelURL('https://api.openai.com/v1'), /loopback/)
  assert.throws(() => localModelURL('http://localhost:11434/v1'), /loopback/)
  assert.throws(() => localModelURL('http://127.0.0.1:11434/v1?redirect=1'), /loopback/)
})

test('local remote worker uses only its on-host model and returns a result', async () => {
  const calls = []
  const result = await runLocalTask(TASK, {
    store: fakeStore(), modelURL: 'http://127.0.0.1:11434/v1', model: 'qwen',
    fetchFn: async (url, options) => {
      calls.push({ url, options })
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'Local findings' } }] }) }
    },
  })
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/v1/chat/completions')
  assert.equal(calls[0].options.redirect, 'error')
  assert.equal(JSON.parse(calls[0].options.body).model, 'qwen')
  assert.deepEqual(result, { status: 'done', result: { summary: 'Local findings', artifacts: [] } })
  assert.equal((await runLocalTask({ ...TASK, kind: 'ops' }, { store: fakeStore() })).status, 'blocked')
})

test('remote scheduler leases its local worker for a delegated size model', () => {
  const pool = createPool({ endpoints: [{ id: 'local-model', kind: 'local', model: 'qwen', concurrency: 1, kinds: ['research', 'ops'], weight: 1 }] })
  const lease = pool.acquire({ ...TASK, delegated: true })
  assert.equal(lease?.endpoint.id, 'local-model')
  lease.release()
})

const TASK = {
  id: 't_1',
  goalId: 'g_1',
  title: 'Survey the forums',
  brief: 'Read and summarise.',
  kind: 'research',
  model: 'sonnet',
  budget: { maxTurns: 30, maxMinutes: 20, maxUsd: 3 },
  allowedSkills: ['dataviz'],
}

/** Just enough store for the remote runner: a goal, a task, an event log. */
function fakeStore(task = TASK) {
  const tasks = new Map([[task.id, { ...task }]])
  const events = []
  return {
    events,
    tasks,
    getGoal: () => ({ id: 'g_1', title: 'Launch the beta', outcome: 'Five testers finish a run' }),
    getTask: (id) => (tasks.has(id) ? { ...tasks.get(id) } : null),
    saveTask: (next) => {
      tasks.set(next.id, { ...next })
      return { ...next }
    },
    appendEvent: (ev) => {
      events.push(ev)
      return ev
    },
  }
}

const json = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  text: async () => JSON.stringify(body),
})

/**
 * A scripted host. Each call is matched by method and path in order of
 * declaration; the calls made are recorded for the assertions.
 */
function host(script) {
  const calls = []
  const fetchFn = async (url, options = {}) => {
    const { pathname, search } = new URL(url)
    const method = options.method ?? 'GET'
    calls.push({
      method,
      path: `${pathname}${search}`,
      auth: options.headers?.authorization ?? null,
      body: options.body ? JSON.parse(options.body) : null,
    })
    const step = script.find((s) => s.method === method && new RegExp(s.path).test(pathname) && !s.used)
    if (!step) throw new Error(`nothing scripted for ${method} ${pathname}`)
    if (step.once) step.used = true
    if (step.throws) throw new Error(step.throws)
    return step.answer
  }
  return { fetchFn, calls }
}

const deps = (store, extra = {}) => ({
  store,
  endpoint: ENDPOINT,
  env: ENV,
  pollMs: 0,
  sleep: async () => {},
  ...extra,
})

test('the task is posted, its handle recorded, progress mirrored, and the outcome returned', async () => {
  const store = fakeStore()
  const handles = []
  const { fetchFn, calls } = host([
    { method: 'POST', path: '^/tasks$', answer: json({ id: 'r_9', goalId: 'g_x' }) },
    {
      method: 'GET',
      path: '^/tasks/r_9$',
      once: true,
      answer: json({ status: 'running', events: [{ text: 'Read the first thread.' }], eventCount: 1 }),
    },
    {
      method: 'GET',
      path: '^/tasks/r_9$',
      answer: json({ status: 'done', result: { summary: 'Six findings.', artifacts: ['notes.md'] }, eventCount: 1 }),
    },
  ])

  const outcome = await runRemoteTask(TASK, deps(store, { fetchFn, onRemote: (h) => handles.push(h) }))

  assert.deepEqual(outcome, { status: 'done', result: { summary: 'Six findings.', artifacts: ['notes.md'] }, failure: null })

  const post = calls[0]
  assert.equal(post.auth, 'Bearer shared-secret')
  assert.equal(post.body.title, TASK.title)
  assert.equal(post.body.kind, 'research')
  assert.deepEqual(post.body.allowedSkills, ['dataviz'])
  assert.deepEqual(post.body.budget, TASK.budget)
  assert.equal(post.body.origin.taskId, 't_1')
  assert.equal(post.body.origin.goalTitle, 'Launch the beta')
  assert.equal(post.body.origin.goalOutcome, 'Five testers finish a run')

  // The handle is written before the first poll and cleared when the run ends,
  // so a restart in between re-attaches and a restart after does not.
  assert.deepEqual(handles, [{ endpointId: 'rigel', id: 'r_9' }, null])

  const texts = store.events.map((e) => e.text)
  assert.deepEqual(texts, ['Delegated to rigel as r_9.', 'rigel: Read the first thread.'])
  assert.ok(store.events.every((e) => e.type === 'task_progress' && e.taskId === 't_1' && e.goalId === 'g_1'))

  // The second poll asked only for what it had not already seen.
  assert.equal(calls[2].path, '/tasks/r_9?since=1')
})

test('a task already posted is re-attached, never sent twice', async () => {
  const store = fakeStore()
  const { fetchFn, calls } = host([
    { method: 'GET', path: '^/tasks/r_5$', answer: json({ status: 'done', result: { summary: 'ok' }, eventCount: 0 }) },
  ])

  const outcome = await runRemoteTask(
    { ...TASK, remote: { endpointId: 'rigel', id: 'r_5' } },
    deps(store, { fetchFn }),
  )

  assert.equal(outcome.status, 'done')
  assert.ok(calls.every((c) => c.method === 'GET'), 'nothing was posted a second time')
  assert.equal(store.events.length, 0, 'a re-attach is not announced as a fresh delegation')
})

test('a handle from another endpoint is not re-attached to this one', async () => {
  const store = fakeStore()
  const { fetchFn, calls } = host([
    { method: 'POST', path: '^/tasks$', answer: json({ id: 'r_new' }) },
    { method: 'GET', path: '^/tasks/r_new$', answer: json({ status: 'done', result: null, eventCount: 0 }) },
  ])

  await runRemoteTask({ ...TASK, remote: { endpointId: 'vega', id: 'r_old' } }, deps(store, { fetchFn }))

  assert.equal(calls.length, 0)
})

test('an endpoint size travels; an endpoint id does not', () => {
  assert.equal(remoteModel('sonnet'), 'sonnet')
  assert.equal(remoteModel('opus'), 'opus')
  // "rigel" means nothing on rigel, and naming it there would pin the work to
  // a box that host has never heard of.
  assert.equal(remoteModel('rigel'), null)
  assert.equal(remoteModel(undefined), null)
})

test('the posted model is the size, with an endpoint id dropped', async () => {
  const store = fakeStore({ ...TASK, model: 'rigel' })
  const { fetchFn, calls } = host([
    { method: 'POST', path: '^/tasks$', answer: json({ id: 'r_1' }) },
    { method: 'GET', path: '^/tasks/r_1$', answer: json({ status: 'done', eventCount: 0 }) },
  ])

  await runRemoteTask({ ...TASK, model: 'rigel' }, deps(store, { fetchFn }))

  assert.equal(calls[0].body.model, null)
})

test('without a token nothing is posted, and the variable to set is named', async () => {
  const store = fakeStore()
  const { fetchFn, calls } = host([])

  const outcome = await runRemoteTask(TASK, deps(store, { fetchFn, env: {} }))

  assert.equal(outcome.status, 'failed')
  assert.equal(outcome.failure.reason, 'remote')
  assert.match(outcome.failure.detail, /RIGEL_TOKEN/)
  assert.equal(calls.length, 0)
})

test('a host that refuses the task fails it here rather than polling for ever', async () => {
  const store = fakeStore()
  const { fetchFn } = host([
    { method: 'POST', path: '^/tasks$', answer: json({ error: 'A delegated task must be one of research, ops' }, { ok: false, status: 400 }) },
  ])

  const outcome = await runRemoteTask(TASK, deps(store, { fetchFn }))

  assert.equal(outcome.status, 'failed')
  assert.match(outcome.failure.detail, /rigel refused the task/)
  assert.match(outcome.failure.detail, /must be one of research, ops/)
})

test('a host that accepts but names no id is a failure, not a silent poll', async () => {
  const store = fakeStore()
  const { fetchFn } = host([{ method: 'POST', path: '^/tasks$', answer: json({ ok: true }) }])

  const outcome = await runRemoteTask(TASK, deps(store, { fetchFn }))

  assert.equal(outcome.status, 'failed')
  assert.match(outcome.failure.detail, /named no id/)
})

test('a cancel here is a cancel there, and the handle is cleared', async () => {
  const store = fakeStore()
  const handles = []
  const controller = new AbortController()
  const { fetchFn, calls } = host([
    { method: 'POST', path: '^/tasks$', answer: json({ id: 'r_7' }) },
    { method: 'GET', path: '^/tasks/r_7$', answer: json({ status: 'running', eventCount: 0 }) },
    { method: 'POST', path: '^/tasks/r_7/cancel$', answer: json({ ok: true }) },
  ])

  const outcome = await runRemoteTask(TASK, deps(store, {
    fetchFn,
    onRemote: (h) => handles.push(h),
    // The abort lands while the runner is waiting out a poll interval.
    sleep: async () => controller.abort(),
    signal: controller.signal,
  }))

  assert.equal(outcome.status, 'cancelled')
  assert.equal(outcome.failure.reason, 'cancelled')
  assert.ok(calls.some((c) => c.path === '/tasks/r_7/cancel'), 'the other host was told to stop')
  assert.equal(handles.at(-1), null)
})

test('a cancel ends the poll interval immediately instead of sitting it out', async () => {
  const store = fakeStore()
  const controller = new AbortController()
  const { fetchFn } = host([
    { method: 'POST', path: '^/tasks$', answer: json({ id: 'r_8' }) },
    { method: 'GET', path: '^/tasks/r_8$', answer: json({ status: 'running', eventCount: 0 }) },
    { method: 'POST', path: '^/tasks/r_8/cancel$', answer: json({ ok: true }) },
  ])

  // A sleep that never finishes: only the abort can end the wait, so this test
  // hangs rather than fails if the interval is not interruptible.
  const outcome = await runRemoteTask(TASK, deps(store, {
    fetchFn,
    pollMs: 60_000,
    sleep: () => new Promise(() => {}),
    signal: controller.signal,
    onRemote: () => setImmediate(() => controller.abort()),
  }))

  assert.equal(outcome.status, 'cancelled')
})

test('a cancel the other host cannot hear fails locally and keeps the handle', async () => {
  const store = fakeStore()
  const controller = new AbortController()
  controller.abort()
  const { fetchFn } = host([{ method: 'POST', path: '^/tasks/r_3/cancel$', throws: 'connection refused' }])

  const outcome = await runRemoteTask(
    { ...TASK, remote: { endpointId: 'rigel', id: 'r_3' } },
    deps(store, { fetchFn, signal: controller.signal }),
  )

  assert.equal(outcome.status, 'failed')
  assert.match(outcome.failure.detail, /Could not confirm cancellation/)
})

test('a few bad answers are survived; many are a lost host, with the handle kept', async () => {
  const store = fakeStore()
  const handles = []
  const lost = []
  const { fetchFn, calls } = host([
    { method: 'GET', path: '^/tasks/r_4$', once: true, answer: json({ status: 'running', eventCount: 0 }) },
    { method: 'GET', path: '^/tasks/r_4$', throws: 'socket hang up' },
  ])

  const outcome = await runRemoteTask(
    { ...TASK, remote: { endpointId: 'rigel', id: 'r_4' } },
    deps(store, { fetchFn, onRemote: (h) => handles.push(h), onLost: (err) => lost.push(err) }),
  )

  assert.equal(outcome.status, 'failed')
  assert.match(outcome.failure.detail, /Lost contact with rigel: socket hang up/)
  assert.equal(calls.length, 6, 'one good poll, then five misses')
  assert.equal(lost.length, 1, 'the endpoint was reported unreachable')
  // Kept deliberately: that host is probably still working on this, so a retry
  // must re-attach rather than start a second copy of the same work.
  assert.deepEqual(handles, [], 'the handle was not cleared')
})

test('an approval waiting on the other machine is said once, not every poll', async () => {
  const store = fakeStore()
  const { fetchFn } = host([
    { method: 'GET', path: '^/tasks/r_6$', once: true, answer: json({ status: 'awaiting_approval', eventCount: 0 }) },
    { method: 'GET', path: '^/tasks/r_6$', once: true, answer: json({ status: 'awaiting_approval', eventCount: 0 }) },
    { method: 'GET', path: '^/tasks/r_6$', answer: json({ status: 'blocked', failure: { reason: 'blocked', detail: 'Needs a key.' }, eventCount: 0 }) },
  ])

  const outcome = await runRemoteTask(
    { ...TASK, remote: { endpointId: 'rigel', id: 'r_6' } },
    deps(store, { fetchFn }),
  )

  assert.equal(outcome.status, 'blocked')
  assert.deepEqual(outcome.failure, { reason: 'blocked', detail: 'Needs a key.' })
  const said = store.events.filter((e) => /waiting on an approval/.test(e.text))
  assert.equal(said.length, 1)
  assert.match(said[0].text, /must be answered there/)
})

test('this machine names itself for the other host, by label when it has one', () => {
  assert.equal(hostLabel({ JARVIS_HOST_LABEL: 'the workshop' }), 'the workshop')
  assert.ok(hostLabel({}).length > 0)
})
