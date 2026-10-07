import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nextRun, scheduleInput } from './schedules.mjs'
import { createStore } from './store.mjs'

const now = '2026-10-06T08:00:00Z'
const input = (trigger) => ({ title: 'Service report', outcome: 'Check service health', trigger })

test('one-time and interval schedules validate and remain anchored', () => {
  assert.equal(scheduleInput(input({ type: 'once', at: '2026-10-06T09:00:00+01:00' }), '2026-10-06T07:00:00Z').nextRunAt, '2026-10-06T08:00:00.000Z')
  assert.throws(() => scheduleInput(input({ type: 'once', at: now }), now), /future/)
  const schedule = scheduleInput(input({ type: 'interval', minutes: 30 }), now)
  assert.equal(schedule.nextRunAt, '2026-10-06T08:30:00.000Z')
  assert.equal(nextRun(schedule.trigger, '2026-10-07T08:41:00Z'), '2026-10-07T09:00:00.000Z')
  assert.throws(() => scheduleInput(input({ type: 'interval', minutes: 0 }), now))
  assert.throws(() => scheduleInput(input({ type: 'once', at: 'tomorrow' }), now))
})

test('daily and selected weekdays use the requested timezone', () => {
  assert.equal(nextRun({ type: 'daily', time: '09:00', timezone: 'Europe/London' }, now), '2026-10-07T08:00:00.000Z')
  assert.equal(nextRun({ type: 'weekly', time: '09:00', timezone: 'Europe/London', days: [1, 5] }, now), '2026-10-09T08:00:00.000Z')
  assert.throws(() => scheduleInput(input({ type: 'daily', time: '25:00', timezone: 'UTC' }), now))
  assert.throws(() => scheduleInput(input({ type: 'daily', time: '09:00', timezone: 'Moon/Base' }), now))
  assert.throws(() => scheduleInput(input({ type: 'weekly', time: '09:00', timezone: 'UTC', days: [] }), now))
})

test('calendar recurrence skips nonexistent DST time and fires once on fall-back day', () => {
  const trigger = { type: 'daily', time: '02:30', timezone: 'America/New_York' }
  assert.equal(nextRun(trigger, '2026-03-08T00:00:00Z'), '2026-03-09T06:30:00.000Z')
  assert.equal(nextRun({ ...trigger, time: '01:30' }, '2026-11-01T05:30:00Z'), '2026-11-02T06:30:00.000Z')
  assert.equal(nextRun({ ...trigger, time: '01:30' }, '2026-11-01T06:00:00Z', '2026-11-01T05:30:00Z'), '2026-11-02T06:30:00.000Z')
})

test('schedule persistence survives reload without creating any goal', () => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-schedules-'))
  const store = createStore(root, { now: () => new Date(now) })
  const schedule = store.newSchedule(input({ type: 'interval', minutes: 30 }))
  assert.deepEqual(createStore(root).getSchedule(schedule.id), schedule)
  assert.equal(store.listGoals().length, 0)
  assert.equal(store.listTasks().length, 0)
})