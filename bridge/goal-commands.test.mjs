import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleGoalRequest, handleReportRequest } from './goal-commands.mjs'

test('report recall reads history and task files with correlated errors and no mutations', async () => {
  const replies = []
  const calls = []
  const api = {
    board: async (options) => { calls.push(options); return { goals: [] } },
    taskReports: async (id, file) => { calls.push({ id, file }); return { file, content: 'Saved report' } },
  }
  const send = (reply) => replies.push(reply)
  await handleReportRequest({ type: 'report_request', requestId: 'history', action: 'history' }, api, send)
  assert.deepEqual(calls[0], { history: true })
  assert.deepEqual(replies[0], { type: 'report_reply', requestId: 'history', result: { goals: [] } })
  await handleReportRequest({ type: 'report_request', requestId: 'file', action: 'task', taskId: 't_123', file: 'latest.md' }, api, send)
  assert.deepEqual(calls[1], { id: 't_123', file: 'latest.md' })
  for (const message of [
    { action: 'unknown' }, { action: 'task', taskId: '../../private' }, { action: 'task', taskId: 't_123', file: '' },
  ]) {
    await handleReportRequest({ type: 'report_request', requestId: 'bad', ...message }, api, send)
    assert.ok(replies.at(-1).error)
  }
  await handleReportRequest({ type: 'report_request', requestId: 'offline', action: 'history' }, null, send)
  assert.match(replies.at(-1).error, /disabled/)
  assert.equal(calls.length, 2)
})

test('attention reply identifies the goal and combines information with resume', async () => {
  const calls = []
  const replies = []
  const api = {
    board: async () => ({ goals: [{ id: 'g_123', status: 'paused' }] }),
    updateGoal: async (id, change) => { calls.push({ id, change }); return { id, status: 'active' } },
  }
  await handleGoalRequest({ type: 'goal_request', requestId: 'one', goalId: 'g_123', info: '  Repository: /repo  ', resume: true }, api, (reply) => replies.push(reply))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].id, 'g_123')
  assert.equal(calls[0].change.action, 'resume')
  assert.match(calls[0].change.info, /^Repository: \/repo\n/)
  assert.match(calls[0].change.info, /approval requirements/)
  assert.deepEqual(replies[0], { type: 'goal_reply', requestId: 'one', result: { id: 'g_123', status: 'active' } })
  await handleGoalRequest({ type: 'goal_request', requestId: 'two', goalId: 'g_123', info: 'More detail', resume: false }, api, () => {})
  assert.equal(calls[1].change.action, undefined)
})

test('attention replies reject invalid input, completed goals, offline and disabled services', async () => {
  const replies = []
  const send = (reply) => replies.push(reply)
  const message = { type: 'goal_request', requestId: 'one', goalId: 'g_123', info: 'Repository: /repo', resume: true }
  const api = { board: async () => ({ goals: [{ id: 'g_123', status: 'done' }] }), updateGoal: async () => assert.fail('must not update') }
  for (const input of [{ ...message, goalId: '../../secret' }, { ...message, info: '  ' }, { ...message, info: 'x'.repeat(10001) }, message]) {
    await handleGoalRequest(input, api, send)
    assert.ok(replies.at(-1).error)
  }
  await handleGoalRequest(message, null, send)
  assert.match(replies.at(-1).error, /disabled/)
  await handleGoalRequest(message, { board: async () => { throw new Error('Service offline') } }, send)
  assert.match(replies.at(-1).error, /offline/)
  assert.equal(await handleGoalRequest({ type: 'ask' }, api, send), false)
  const count = replies.length
  await handleGoalRequest({ ...message, requestId: '' }, api, send)
  assert.equal(replies.length, count)
})