import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from './store.mjs'
import { createScheduler, isRateLimit } from './scheduler.mjs'

const deferred = () => {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
const settle = () => new Promise((r) => setImmediate(r))

function harness({ maxWorkers = 3 } = {}) {
  let clock = Date.parse('2026-09-29T00:00:00Z')
  const store = createStore(mkdtempSync(join(tmpdir(), 'agents-sched-')), { workDir: '/work', now: () => new Date(clock) })
  const runs = new Map()
  const reviews = []
  const cancelled = []
  const scheduler = createScheduler({
    store,
    maxWorkers,
    now: () => clock,
    sleep: async () => {},
    retryDelayMs: 0,
    onCancel: (id) => cancelled.push(id),
    coordinator: { review: async (goalId, ev) => { reviews.push(ev) } },
    runTask: (task, { signal }) => {
      const d = deferred()
      runs.set(task.id, { ...d, signal })
      return d.promise
    },
  })
  return { store, runs, reviews, cancelled, scheduler, advance: (ms) => { clock += ms } }
}

const DONE = { status: 'done', result: { summary: 'ok', artifacts: [] } }

test('a task waits for its dependencies, then runs; the coordinator reviews each ending', async () => {
  const h = harness()
  const g = h.store.newGoal({ title: 'G', outcome: 'O' })
  const a = h.store.newTask({ goalId: g.id, title: 'A', brief: 'a' })
  const b = h.store.newTask({ goalId: g.id, title: 'B', brief: 'b', dependsOn: [a.id] })
  h.scheduler.tick()
  assert.deepEqual([...h.runs.keys()], [a.id])
  assert.equal(h.store.getTask(a.id).status, 'running')
  h.runs.get(a.id).resolve(DONE)
  await h.scheduler.idle()
  const doneA = h.store.getTask(a.id)
  assert.equal(doneA.status, 'done')
  assert.equal(doneA.attempts, 1)
  assert.equal(h.reviews[0].type, 'task_done')
  assert.equal(h.reviews[0].data.title, 'A')
  assert.equal(h.reviews[0].data.goalTitle, 'G')
  assert.ok(h.runs.has(b.id))
})

test('never more than the cap at once', () => {
  const h = harness()
  const g = h.store.newGoal({ title: 'G', outcome: 'O' })
  for (let i = 0; i < 5; i++) h.store.newTask({ goalId: g.id, title: `T${i}`, brief: 'b' })
  h.scheduler.tick()
  h.scheduler.tick()
  assert.equal(h.runs.size, 3)
  assert.equal(h.scheduler.running().size, 3)
})

test('higher-priority goals go first; paused goals wait', () => {
  const h = harness({ maxWorkers: 1 })
  const low = h.store.newGoal({ title: 'Low', outcome: 'O', priority: 5 })
  const paused = h.store.newGoal({ title: 'Paused', outcome: 'O', priority: 1 })
  const high = h.store.newGoal({ title: 'High', outcome: 'O', priority: 2 })
  h.store.saveGoal({ ...paused, status: 'paused' })
  h.store.newTask({ goalId: low.id, title: 'L', brief: 'b' })
  h.store.newTask({ goalId: paused.id, title: 'P', brief: 'b' })
  const hi = h.store.newTask({ goalId: high.id, title: 'H', brief: 'b' })
  h.scheduler.tick()
  assert.deepEqual([...h.runs.keys()], [hi.id])
})

test('a thrown error is retried once, then the attempt fails', async () => {
  const h = harness()
  const g = h.store.newGoal({ title: 'G', outcome: 'O' })
  const t = h.store.newTask({ goalId: g.id, title: 'T', brief: 'b' })
  h.scheduler.tick()
  h.runs.get(t.id).reject(new Error('boom'))
  await settle()
  await settle()
  h.runs.get(t.id).reject(new Error('boom again'))
  await h.scheduler.idle()
  const saved = h.store.getTask(t.id)
  assert.equal(saved.status, 'failed')
  assert.equal(saved.failure.reason, 'error')
  assert.equal(saved.attempts, 1)
})

test('a rate limit re-queues the task and backs off without spending an attempt', async () => {
  const h = harness()
  const g = h.store.newGoal({ title: 'G', outcome: 'O' })
  const t = h.store.newTask({ goalId: g.id, title: 'T', brief: 'b' })
  h.scheduler.tick()
  const first = h.runs.get(t.id)
  first.reject(new Error('429 rate limit exceeded'))
  await h.scheduler.idle()
  assert.equal(h.store.getTask(t.id).status, 'queued')
  assert.equal(h.store.getTask(t.id).attempts, 0)
  h.scheduler.tick()
  assert.equal(h.runs.get(t.id), first)
  h.advance(31_000)
  h.scheduler.tick()
  assert.notEqual(h.runs.get(t.id), first)
})

test('isRateLimit recognises the usual shapes', () => {
  assert.ok(isRateLimit(new Error('Rate limit reached')))
  assert.ok(isRateLimit(new Error('HTTP 429')))
  assert.ok(isRateLimit(new Error('API overloaded')))
  assert.ok(!isRateLimit(new Error('boom')))
})

test('cancel aborts a running task and cancels a queued one', async () => {
  const h = harness({ maxWorkers: 1 })
  const g = h.store.newGoal({ title: 'G', outcome: 'O' })
  const a = h.store.newTask({ goalId: g.id, title: 'A', brief: 'a' })
  const b = h.store.newTask({ goalId: g.id, title: 'B', brief: 'b' })
  h.scheduler.tick()
  assert.equal(h.scheduler.cancel(b.id), true)
  assert.equal(h.store.getTask(b.id).status, 'cancelled')
  assert.equal(h.scheduler.cancel(a.id), true)
  assert.equal(h.runs.get(a.id).signal.aborted, true)
  assert.deepEqual(h.cancelled, [b.id, a.id])
  h.runs.get(a.id).resolve({ status: 'cancelled', failure: { reason: 'cancelled', detail: 'x' } })
  await h.scheduler.idle()
  assert.equal(h.store.getTask(a.id).status, 'cancelled')
  assert.equal(h.reviews.length, 0)
  assert.equal(h.scheduler.cancel('t_missing'), false)
})

test('a recurring goal re-queues its last task once the interval has passed', async () => {
  const h = harness()
  const g = h.store.newGoal({ title: 'Check', outcome: 'O', recurring: { every: '1h' } })
  const t = h.store.newTask({ goalId: g.id, title: 'Run the check', brief: 'check things', kind: 'ops' })
  h.scheduler.tick()
  h.runs.get(t.id).resolve(DONE)
  await h.scheduler.idle()
  h.advance(30 * 60_000)
  h.scheduler.tick()
  assert.equal(h.store.listTasks({ goalId: g.id }).length, 1)
  h.advance(31 * 60_000)
  h.scheduler.tick()
  const tasks = h.store.listTasks({ goalId: g.id })
  assert.equal(tasks.length, 2)
  const next = tasks.find((x) => x.id !== t.id)
  assert.equal(next.title, 'Run the check')
  assert.equal(next.kind, 'ops')
  assert.ok(h.runs.has(next.id))
})
