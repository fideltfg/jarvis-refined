import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeTrigger, localDateTime, onceFromLocal } from './schedules.ts'

test('schedule labels describe intervals and weekday calendar times', () => {
  assert.equal(describeTrigger({ type: 'interval', minutes: 120 }), 'Every 2 hours')
  assert.equal(describeTrigger({ type: 'weekly', time: '09:00', timezone: 'UTC', days: [1, 3] }), 'Mon, Wed at 09:00 · UTC')
})

test('one-time local timestamps round trip and reject DST ambiguity', () => {
  const previous = process.env.TZ
  process.env.TZ = 'America/New_York'
  try {
    assert.equal(onceFromLocal('2026-10-06T09:00'), '2026-10-06T13:00:00.000Z')
    assert.equal(localDateTime('2026-10-06T13:00:00Z'), '2026-10-06T09:00')
    assert.throws(() => onceFromLocal('2026-03-08T02:30'), /does not exist/)
    assert.throws(() => onceFromLocal('2026-11-01T01:30'), /occurs twice/)
    assert.throws(() => onceFromLocal('tomorrow'), /date and time/)
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous }
})