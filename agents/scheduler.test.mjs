import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from './store.mjs'
import { createScheduler, isRateLimit } from './scheduler.mjs'
import { createPool } from './pool.mjs'
import { parseEndpoints } from '../bridge/endpoints.mjs'

/** Create a controllable promise for simulating worker completion in tests. */
const deferred = () => {
  let resolve, reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    // Expose the promise settlement functions to the test harness.
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
/** Let queued promise handlers run before inspecting scheduler state. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

function harness({ maxWorkers = 3, pool = null } = {}) {
  let clock = Date.parse('2026-09-29T00:00:00Z')
  const store = createStore(mkdtempSync(join(tmpdir(), 'agents-sched-')), { workDir: '/work', now: () => new Date(clock) })
  const runs = new Map()
  const reviews = []
  const cancelled = []
  const scheduler = createScheduler({
    store,
    maxWorkers,
    pool,
    now: () => clock,
    sleep: async () => {},
    retryDelayMs: 0,
    // Record scheduler cancellation callbacks for assertions.
    onCancel: (id) => cancelled.push(id),
    // Capture goal reviews without invoking a coordinator model.
    coordinator: { review: async (goalId, ev) => { reviews.push(ev) } },
    // Keep worker promises pending until the test explicitly settles them.
    runTask: (task, { signal, endpoint }) => {
      const d = deferred()
      runs.set(task.id, { ...d, signal, endpoint })
      return d.promise
    },
  })
  return { store, runs, reviews, cancelled, scheduler, advance: (ms) => { clock += ms } }
}

const DONE = { status: 'done', result: { summary: 'ok', artifacts: [] } }

// Verify a saved schedule recovers and runs when the service starts listening.
test('persisted schedules run after service restart without a browser or event subscriber', async () => {
  let clock = Date.parse('2026-10-06T08:00:00Z')
  const root = mkdtempSync(join(tmpdir(), 'agents-schedule-restart-'))
  const initial = createStore(root, { workDir: '/work', now: () => new Date(clock) })
  const saved = initial.newSchedule({ title: 'Health', outcome: 'Check services', trigger: { type: 'interval', minutes: 30 } })
  assert.equal(initial.listGoals().length, 0)
  clock += 24 * 3600000
  const store = createStore(root, { workDir: '/work', now: () => new Date(clock) })
  const runs = []
  const coordinator = {
    // Simulate the coordinator adding a task for each recovered schedule goal.
    plan: async (goalId) => {
      const task = store.newTask({ goalId, title: 'Health', brief: 'Check services' })
      store.appendEvent({ type: 'task_queued', goalId, taskId: task.id, text: 'Queued' })
    },
    // Mark the schedule goal complete after its worker result is reviewed.
    review: async (goalId) => store.saveGoal({ ...store.getGoal(goalId), status: 'done', notes: 'Healthy' }),
  }
  const scheduler = createScheduler({ store, coordinator, now: () => clock, runTask: async (task) => { runs.push(task.id); return DONE } })
  try {
    scheduler.start()
    await scheduler.idle()
    scheduler.tick()
    await scheduler.idle()
    assert.equal(runs.length, 1)
    assert.equal(store.listGoals().length, 1)
    assert.equal(store.listTasks()[0].status, 'done')
    assert.equal(store.getSchedule(saved.id).nextRunAt, '2026-10-07T08:30:00.000Z')
    assert.equal(store.getGoal(store.getSchedule(saved.id).lastGoalId).status, 'done')
  } finally { scheduler.stop() }
})

// Check dependency gating, task persistence, and review of completed work.
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

// Ensure repeated scheduler ticks cannot exceed the worker cap.
test('never more than the cap at once', () => {
  const h = harness()
  const g = h.store.newGoal({ title: 'G', outcome: 'O' })
  for (let i = 0; i < 5; i++) h.store.newTask({ goalId: g.id, title: `T${i}`, brief: 'b' })
  h.scheduler.tick()
  h.scheduler.tick()
  assert.equal(h.runs.size, 3)
  assert.equal(h.scheduler.running().size, 3)
})

// Verify priority order skips paused goals even when they have higher priority.
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

// Cover one worker retry followed by a persisted terminal failure.
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

// Confirm rate limits requeue work and delay retries without consuming an attempt.
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

// Lock the provider capacity-error strings that activate scheduler backoff.
test('isRateLimit recognises the usual shapes', () => {
  assert.ok(isRateLimit(new Error('Rate limit reached')))
  assert.ok(isRateLimit(new Error('HTTP 429')))
  assert.ok(isRateLimit(new Error('API overloaded')))
  assert.ok(!isRateLimit(new Error('boom')))
})

// Check running-task aborts, queued-task cancellation, and skipped coordinator review.
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

// Ensure recurring work waits for its interval before creating the next task.
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

// Verify malformed recurring metadata and missing dependency arrays do not stop ticks.
test('F10: hand-edited files with bad values do not crash the loop', () => {
  const h = harness()
  const bad = h.store.newGoal({ title: 'Bad', outcome: 'O' })
  h.store.saveGoal({ ...bad, recurring: { every: 'six hours' } })
  h.store.saveTask({ ...h.store.newTask({ goalId: bad.id, title: 'Old', brief: 'b' }), status: 'done' })
  const g = h.store.newGoal({ title: 'G', outcome: 'O' })
  const t = h.store.newTask({ goalId: g.id, title: 'No deps field', brief: 'b' })
  // Remove the field to simulate an older or hand-edited task record.
  const withoutDeps = { ...h.store.getTask(t.id) }
  delete withoutDeps.dependsOn
  h.store.saveTask(withoutDeps)
  assert.doesNotThrow(() => h.scheduler.tick())
  assert.ok(h.runs.has(t.id))
})

// Check recurring-run retention and the workspace archival callback.
test('F11: recurring runs archive old tasks, keep the last three and hand them to onArchive', async () => {
  let clock = Date.parse('2026-09-29T00:00:00Z')
  const store = createStore(mkdtempSync(join(tmpdir(), 'agents-rec11-')), { workDir: '/work', now: () => new Date(clock) })
  const archived = []
  const runs = new Map()
  const scheduler = createScheduler({
    store, now: () => clock, sleep: async () => {}, retryDelayMs: 0,
    // Capture tasks handed to workspace cleanup.
    onArchive: (task) => archived.push(task.id),
    coordinator: { review: async () => {} },
    // Hold each recurring worker until the test resolves it.
    runTask: (task) => { const d = deferred(); runs.set(task.id, d); return d.promise },
  })
  const g = store.newGoal({ title: 'Check', outcome: 'O', recurring: { every: '1h' } })
  store.newTask({ goalId: g.id, title: 'Run', brief: 'b', kind: 'ops' })
  for (let i = 0; i < 6; i++) {
    scheduler.tick()
    const running = store.listTasks({ status: 'running' })[0]
    runs.get(running.id).resolve(DONE)
    await scheduler.idle()
    clock += 61 * 60_000
  }
  const live = store.listTasks({ goalId: g.id }).filter((task) => {
    // Compare only current history against the retained-run limit.
    return !task.archived
  })
  assert.ok(live.length <= 4)
  assert.ok(archived.length >= 2)
  assert.ok(store.listTasks({ goalId: g.id }).filter((task) => {
    // Every archived record should have reached the archive callback.
    return task.archived
  }).every((task) => archived.includes(task.id)))
})

// -- leasing across endpoints -----------------------------------------------

// A task may only be pinned to an endpoint the registry knows, and the store
// checks that on the way in, so these two boxes have to be declared in the
// environment as well as handed to the pool.
const BOXES = [
  { id: 'cloud', kind: 'anthropic', concurrency: 1 },
  { id: 'rigel', kind: 'gateway', baseURL: 'http://11.0.0.9:4000', model: 'llama3.1:8b', concurrency: 1 },
]
process.env.JARVIS_ENDPOINTS = JSON.stringify(BOXES)

const twoBoxes = () => createPool({ endpoints: parseEndpoints(BOXES) })
/** Build a pool from the two fake endpoints used in lease tests. */

// Verify endpoint assignment, runtime reporting, and lease release after completion.
test('with a pool, each run is leased to an endpoint and the lease comes back', async () => {
  const pool = twoBoxes()
  const h = harness({ maxWorkers: 9, pool })
  const g = h.store.newGoal({ title: 'G', outcome: 'O' })
  const a = h.store.newTask({ goalId: g.id, title: 'A', brief: 'a' })
  const b = h.store.newTask({ goalId: g.id, title: 'B', brief: 'b', model: 'rigel' })
  const c = h.store.newTask({ goalId: g.id, title: 'C', brief: 'c' })

  h.scheduler.tick()
  assert.equal(h.runs.get(a.id).endpoint.id, 'cloud')
  assert.equal(h.runs.get(b.id).endpoint.id, 'rigel')
  assert.equal(h.runs.has(c.id), false, 'both endpoints are full, so C waits')
  assert.equal(pool.inFlight(), 2)

  // The endpoint that carried the work is recorded with the start.
  const started = h.store.readEvents().filter((e) => e.type === 'task_started')
  assert.deepEqual(started.map((e) => e.data.endpoint).sort(), ['cloud', 'rigel'])
  // And on the task itself, so the board can say where every agent runs.
  assert.equal(h.store.getTask(a.id).runtime.provider, 'anthropic')
  assert.equal(h.store.getTask(a.id).runtime.model, 'sonnet')
  assert.equal(h.store.getTask(b.id).runtime.endpointId, 'rigel')
  assert.equal(h.store.getTask(b.id).runtime.provider, 'gateway')
  assert.equal(h.store.getTask(b.id).runtime.model, 'llama3.1:8b')
  assert.match(h.store.getTask(b.id).runtime.startedAt, /^\d{4}-/)

  // Both runs end. Releasing a lease ticks the scheduler, so the slot is not
  // merely given back: C is placed on it without waiting for the next timer.
  h.runs.get(a.id).resolve(DONE)
  h.runs.get(b.id).resolve(DONE)
  await h.scheduler.idle()
  assert.equal(h.runs.get(c.id).endpoint.id, 'cloud')
  assert.equal(pool.inFlight(), 1, 'two leases back, one taken again by C')
  h.runs.get(c.id).resolve(DONE)
  await h.scheduler.idle()
  assert.equal(pool.inFlight(), 0, 'nothing holds capacity once the queue is empty')
})

// Ensure a busy pinned endpoint does not block unrelated runnable work.
test('a task pinned to a busy endpoint is stepped over, not a barrier', async () => {
  const pool = twoBoxes()
  pool.acquire({ model: 'rigel' })
  const h = harness({ maxWorkers: 9, pool })
  const g = h.store.newGoal({ title: 'G', outcome: 'O' })
  const pinned = h.store.newTask({ goalId: g.id, title: 'Pinned', brief: 'a', model: 'rigel' })
  const next = h.store.newTask({ goalId: g.id, title: 'Next', brief: 'b' })

  h.scheduler.tick()
  assert.equal(h.runs.has(pinned.id), false)
  assert.equal(h.runs.get(next.id).endpoint.id, 'cloud', 'the queue carried on past the blocked one')
  assert.equal(h.store.getTask(pinned.id).status, 'queued')
})

// Confirm rate-limited or failed work returns its endpoint capacity.
test('a run that ends badly still returns its slot', async () => {
  const pool = createPool({ endpoints: parseEndpoints([{ id: 'cloud', kind: 'anthropic', concurrency: 1 }]) })
  const h = harness({ maxWorkers: 9, pool })
  const g = h.store.newGoal({ title: 'G', outcome: 'O' })
  const a = h.store.newTask({ goalId: g.id, title: 'A', brief: 'a' })
  h.scheduler.tick()
  assert.equal(pool.inFlight(), 1)
  h.runs.get(a.id).reject(new Error('429 rate limit exceeded'))
  await h.scheduler.idle()
  assert.equal(h.store.getTask(a.id).status, 'queued')
  assert.equal(pool.inFlight(), 0, 'a rate-limited run must not keep the slot for the life of the process')
})

// Preserve the legacy global worker ceiling when no endpoint pool exists.
test('with no pool the old fixed ceiling still governs', () => {
  const h = harness({ maxWorkers: 1 })
  const g = h.store.newGoal({ title: 'G', outcome: 'O' })
  const a = h.store.newTask({ goalId: g.id, title: 'A', brief: 'a' })
  const b = h.store.newTask({ goalId: g.id, title: 'B', brief: 'b' })
  h.scheduler.tick()
  assert.equal(h.runs.size, 1)
  assert.equal(h.runs.get(a.id).endpoint, null, 'no pool means no endpoint named')
  assert.equal(h.runs.has(b.id), false)
})
