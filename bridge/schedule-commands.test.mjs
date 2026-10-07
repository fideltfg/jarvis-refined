import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleScheduleRequest } from './schedule-commands.mjs'

test('schedule commands are validated, allowlisted and acknowledged', async () => {
  const replies = []
  const calls = []
  const api = { createSchedule: async (input) => { calls.push(input); return { id: 's_123' } } }
  const send = (reply) => replies.push(reply)
  await handleScheduleRequest({ type: 'schedule_request', requestId: 'one', action: 'create', input: { title: 'Report', outcome: 'Check services', trigger: { type: 'interval', minutes: 30 } } }, api, send)
  assert.equal(calls.length, 1)
  assert.equal(replies[0].requestId, 'one')
  assert.equal(replies[0].result.id, 's_123')
  await handleScheduleRequest({ type: 'schedule_request', requestId: 'two', action: 'shell' }, api, send)
  assert.ok(replies[1].error)
  await handleScheduleRequest({ type: 'schedule_request', requestId: 'three', action: 'run', id: '../../secret' }, api, send)
  assert.ok(replies[2].error)
  assert.equal(await handleScheduleRequest({ type: 'ask' }, api, send), false)
})

test('disabled and offline services return errors instead of successful replies', async () => {
  const replies = []
  const message = { type: 'schedule_request', requestId: 'one', action: 'list' }
  await handleScheduleRequest(message, null, (reply) => replies.push(reply))
  assert.match(replies[0].error, /disabled/)
  await handleScheduleRequest(message, { schedules: async () => { throw new Error('Service offline') } }, (reply) => replies.push(reply))
  assert.match(replies[1].error, /offline/)
})