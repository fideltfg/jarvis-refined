import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore, newId } from './store.mjs'
import { createScheduledJobs } from './scheduled-jobs.mjs'

function harness(plan = async () => {}) {
  let clock = Date.parse('2026-10-06T08:00:00Z')
  const store = createStore(mkdtempSync(join(tmpdir(), 'scheduled-jobs-')), { now: () => new Date(clock) })
  const plans = []
  const dependencies = { store, now: () => clock, coordinator: { plan: async (id) => { plans.push(id); await plan(id, store) } } }
  const jobs = createScheduledJobs(dependencies)
  const create = (trigger = { type: 'interval', minutes: 30 }) => jobs.create({ title: 'Report', outcome: 'Check health', trigger })
  return { store, plans, jobs, create, dependencies, advance: (ms) => { clock += ms } }
}

test('nothing plans early; a one-time occurrence fires only once', async () => {
  const h = harness()
  const schedule = h.create({ type: 'once', at: '2026-10-06T08:30:00Z' })
  h.jobs.tick()
  assert.equal(h.plans.length, 0)
  h.advance(30 * 60000)
  h.jobs.tick()
  h.jobs.tick()
  await h.jobs.idle()
  h.jobs.tick()
  assert.equal(h.plans.length, 1)
  assert.equal(h.store.getSchedule(schedule.id).status, 'completed')
  assert.equal(h.store.listGoals().length, 1)
  assert.throws(() => h.jobs.update(schedule.id, { action: 'pause' }), /completed/)
  assert.throws(() => h.jobs.runNow(schedule.id), /runnable/)
})

test('missed occurrences coalesce and active or paused goals prevent overlap', async () => {
  const h = harness()
  const schedule = h.create()
  h.advance(24 * 3600000)
  h.jobs.tick()
  await h.jobs.idle()
  assert.equal(h.plans.length, 1)
  const goal = h.store.listGoals()[0]
  h.store.saveGoal({ ...goal, status: 'paused' })
  h.advance(3600000)
  h.jobs.tick()
  assert.equal(h.plans.length, 1)
  h.store.saveGoal({ ...goal, status: 'done' })
  h.jobs.tick()
  await h.jobs.idle()
  assert.equal(h.plans.length, 2)
  assert.equal(h.store.getSchedule(schedule.id).nextRunAt, '2026-10-07T09:30:00.000Z')
})

test('pause, resume, manual run and delete preserve existing goals and cadence', async () => {
  const h = harness()
  const schedule = h.create()
  h.jobs.update(schedule.id, { action: 'pause' })
  h.advance(60000)
  h.jobs.runNow(schedule.id)
  await h.jobs.idle()
  assert.equal(h.store.getSchedule(schedule.id).nextRunAt, schedule.nextRunAt)
  assert.equal(h.store.getSchedule(schedule.id).status, 'paused')
  assert.throws(() => h.jobs.runNow(schedule.id), /still active/)
  h.jobs.update(schedule.id, { action: 'resume' })
  h.jobs.update(schedule.id, { action: 'delete' })
  assert.equal(h.store.listGoals()[0].status, 'active')
  assert.throws(() => h.jobs.runNow(schedule.id), /runnable/)
})

test('recovery reuses a reserved goal id before and after goal creation', async () => {
  for (const goalExists of [false, true]) {
    const h = harness()
    const schedule = h.create()
    const goalId = newId('g')
    const occurrence = { key: 'fixed-occurrence', goalId, startedAt: '2026-10-06T08:30:00Z' }
    h.store.saveSchedule({ ...schedule, pendingOccurrence: occurrence })
    if (goalExists) h.store.newGoal({ id: goalId, title: 'Report', outcome: 'Check', scheduleId: schedule.id, occurrenceKey: occurrence.key })
    const recovered = createScheduledJobs(h.dependencies)
    recovered.tick()
    await recovered.idle()
    assert.equal(h.store.listGoals().length, 1)
    assert.equal(h.plans[0], goalId)
    assert.equal(h.store.getSchedule(schedule.id).pendingOccurrence, null)
  }
})

test('recovery never replans a goal that already has tasks', async () => {
  const h = harness()
  const schedule = h.create()
  const goal = h.store.newGoal({ title: 'Report', outcome: 'Check' })
  h.store.newTask({ goalId: goal.id, title: 'Check', brief: 'Health report' })
  h.store.saveSchedule({ ...schedule, pendingOccurrence: { key: 'run', goalId: goal.id, startedAt: schedule.nextRunAt } })
  h.jobs.tick()
  await h.jobs.idle()
  assert.equal(h.plans.length, 0)
  assert.equal(h.store.getSchedule(schedule.id).lastGoalId, goal.id)
})

test('planning failures back off and pause after three attempts', async () => {
  const h = harness(async () => { throw new Error('Provider unavailable') })
  const schedule = h.create()
  h.jobs.runNow(schedule.id)
  await h.jobs.idle()
  h.jobs.tick()
  assert.equal(h.plans.length, 1)
  for (let attempt = 1; attempt < 3; attempt++) {
    h.advance(attempt * 60000)
    h.jobs.tick()
    await h.jobs.idle()
  }
  assert.equal(h.plans.length, 3)
  assert.equal(h.store.listGoals().length, 1)
  assert.equal(h.store.getSchedule(schedule.id).status, 'paused')
  assert.equal(h.store.listGoals()[0].status, 'abandoned')
})

test('editing title preserves priority and the interval anchor', () => {
  const h = harness()
  const schedule = h.jobs.create({ title: 'Report', outcome: 'Check', priority: 1, trigger: { type: 'interval', minutes: 30 } })
  h.advance(3600000)
  const edited = h.jobs.update(schedule.id, { action: 'edit', values: { title: 'Health' } })
  assert.equal(edited.priority, 1)
  assert.deepEqual(edited.trigger, schedule.trigger)
  assert.equal(edited.nextRunAt, schedule.nextRunAt)
})