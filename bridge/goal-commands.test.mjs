import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleDecisionRequest, handleGoalControlRequest, handleGoalDecisionRequest, handleGoalRequest, handleReportRequest } from './goal-commands.mjs'

test('report recall reads history and task files with correlated errors and no mutations', async () => {
  const replies = []
  const calls = []
  const api = {
    board: async (options) => { calls.push(options); return { goals: [] } },
    taskReports: async (id, file) => { calls.push({ id, file }); return { file, content: 'Saved report' } },
    taskReference: async (id, index) => { calls.push({ id, index }); return { file: 'Reference', content: 'Saved document' } },
  }
  const send = (reply) => replies.push(reply)
  await handleReportRequest({ type: 'report_request', requestId: 'history', action: 'history' }, api, send)
  assert.deepEqual(calls[0], { history: true })
  assert.deepEqual(replies[0], { type: 'report_reply', requestId: 'history', result: { goals: [] } })
  await handleReportRequest({ type: 'report_request', requestId: 'file', action: 'task', taskId: 't_123', file: 'latest.md' }, api, send)
  assert.deepEqual(calls[1], { id: 't_123', file: 'latest.md' })
  await handleReportRequest({ type: 'report_request', requestId: 'reference', action: 'reference', taskId: 't_123', index: 0 }, api, send)
  assert.deepEqual(calls[2], { id: 't_123', index: 0 })
  for (const message of [
    { action: 'unknown' }, { action: 'task', taskId: '../../private' }, { action: 'task', taskId: 't_123', file: '' },
  ]) {
    await handleReportRequest({ type: 'report_request', requestId: 'bad', ...message }, api, send)
    assert.ok(replies.at(-1).error)
  }
  await handleReportRequest({ type: 'report_request', requestId: 'offline', action: 'history' }, null, send)
  assert.match(replies.at(-1).error, /disabled/)
  assert.equal(calls.length, 3)
})

test('decision answers must match every option on a currently blocked task', async () => {
  const replies = []
  const calls = []
  const goal = { id: 'g_123', status: 'paused', tasks: [{
    id: 't_123', title: 'Choose deployment region', status: 'blocked',
    failure: { blocker: 'decision', questions: [{ id: 'region', prompt: 'Which region?', options: [{ id: 'west', label: 'West' }, { id: 'east', label: 'East', detail: 'Closer to users' }] }] },
  }] }
  const api = {
    board: async () => ({ goals: [goal] }),
    updateGoal: async (id, change) => { calls.push({ id, change }); return { id, status: 'active' } },
  }
  const message = { type: 'decision_request', requestId: 'answer', goalId: 'g_123', taskId: 't_123', answers: { region: 'east' }, note: 'Keep rollback risk minimal.' }
  await handleDecisionRequest(message, api, (reply) => replies.push(reply))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].change.action, 'resume')
  assert.match(calls[0].change.info, /Which region\?: East \(Closer to users\)/)
  assert.ok(calls[0].change.info.includes('\n- Which region?: East'))
  assert.match(calls[0].change.info, /Additional note: Keep rollback risk minimal\./)
  assert.deepEqual(replies[0], { type: 'decision_reply', requestId: 'answer', result: { id: 'g_123', status: 'active' } })
  await handleDecisionRequest({ ...message, answers: { region: 'other' } }, api, (reply) => replies.push(reply))
  assert.match(replies.at(-1).error, /option is no longer available/)
  await handleDecisionRequest(message, { ...api, board: async () => ({ goals: [{ ...goal, tasks: [{ ...goal.tasks[0], status: 'done' }] }] }) }, (reply) => replies.push(reply))
  assert.match(replies.at(-1).error, /no longer waiting/)
  assert.equal(await handleDecisionRequest({ type: 'ask' }, api, () => {}), false)
})

test('goal controls pause, resume and abandon only live goals', async () => {
  const replies = []
  const calls = []
  let status = 'active'
  const api = {
    board: async () => ({ goals: [{ id: 'g_123', status }] }),
    updateGoal: async (id, change) => { calls.push({ id, change }); status = change.action === 'pause' ? 'paused' : change.action === 'resume' ? 'active' : 'abandoned'; return { id, status } },
  }
  const send = (reply) => replies.push(reply)
  await handleGoalControlRequest({ type: 'goal_control_request', requestId: 'pause', goalId: 'g_123', action: 'pause' }, api, send)
  await handleGoalControlRequest({ type: 'goal_control_request', requestId: 'resume', goalId: 'g_123', action: 'resume' }, api, send)
  await handleGoalControlRequest({ type: 'goal_control_request', requestId: 'stop', goalId: 'g_123', action: 'abandon' }, api, send)
  assert.deepEqual(calls.map((call) => call.change.action), ['pause', 'resume', 'abandon'])
  assert.equal(replies.at(-1).result.status, 'abandoned')
  await handleGoalControlRequest({ type: 'goal_control_request', requestId: 'stale', goalId: 'g_123', action: 'resume' }, api, send)
  assert.match(replies.at(-1).error, /can no longer be changed/)
  assert.equal(await handleGoalControlRequest({ type: 'ask' }, api, send), false)
})

test('goal-level approval presents an approve/deny decision without running rejected work', async () => {
  const calls = []
  const replies = []
  const api = {
    board: async () => ({ goals: [{ id: 'g_123', title: 'Release readiness', status: 'paused', awaitingResponse: true }] }),
    updateGoal: async (id, change) => { calls.push({ id, change }); return { id, status: change.action === 'resume' ? 'active' : 'paused' } },
  }
  const send = (reply) => replies.push(reply)
  await handleGoalDecisionRequest({ type: 'goal_decision_request', requestId: 'approve', goalId: 'g_123', decision: 'approve', note: 'Proceed with docs only.' }, api, send)
  assert.equal(calls[0].change.action, 'resume')
  assert.match(calls[0].change.info, /approved the proposed plan/)
  assert.match(calls[0].change.info, /\n\nUser note: Proceed with docs only\./)
  await handleGoalDecisionRequest({ type: 'goal_decision_request', requestId: 'deny', goalId: 'g_123', decision: 'not_approve' }, api, send)
  assert.equal(calls[1].change.action, undefined)
  assert.match(calls[1].change.info, /did not approve/)
  assert.match(calls[1].change.info, /keep this goal paused/)
  assert.deepEqual(replies.map((reply) => reply.type), ['goal_decision_reply', 'goal_decision_reply'])
  await handleGoalDecisionRequest({ type: 'goal_decision_request', requestId: 'stale', goalId: 'g_123', decision: 'approve' }, { ...api, board: async () => ({ goals: [{ id: 'g_123', status: 'done' }] }) }, send)
  assert.match(replies.at(-1).error, /no longer waiting/)
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
test('erase reaches finished goals through history and is refused for live ones', async () => {
  const replies = []
  const calls = []
  const boards = []
  let status = 'active'
  const api = {
    board: async (options) => { boards.push(options); return { goals: status === 'gone' ? [] : [{ id: 'g_123', status }] } },
    updateGoal: async (id, change) => {
      calls.push({ id, change })
      if (change.action === 'erase') { status = 'gone'; return { id, deleted: true, tasks: 3 } }
      status = 'abandoned'
      return { id, status }
    },
  }
  const send = (reply) => replies.push(reply)
  const erase = { type: 'goal_control_request', requestId: 'erase', goalId: 'g_123', action: 'erase' }

  // Active work is the service's to stop first; the relay will not pass it on.
  await handleGoalControlRequest(erase, api, send)
  assert.match(replies.at(-1).error, /finished or been stopped/)
  assert.equal(calls.length, 0)

  status = 'paused'
  await handleGoalControlRequest(erase, api, send)
  assert.match(replies.at(-1).error, /finished or been stopped/)
  assert.equal(calls.length, 0)

  // Done or abandoned: allowed, and looked up with history on, because the
  // live board has already dropped the goal.
  status = 'done'
  await handleGoalControlRequest(erase, api, send)
  assert.deepEqual(calls, [{ id: 'g_123', change: { action: 'erase' } }])
  assert.deepEqual(boards.at(-1), { history: true })
  assert.deepEqual(replies.at(-1), { type: 'goal_control_reply', requestId: 'erase', result: { id: 'g_123', deleted: true, tasks: 3 } })

  // Already gone: refused rather than retried.
  await handleGoalControlRequest(erase, api, send)
  assert.match(replies.at(-1).error, /finished or been stopped/)
  assert.equal(calls.length, 1)

  // A live control still reads the live board, not the history.
  status = 'active'
  await handleGoalControlRequest({ type: 'goal_control_request', requestId: 'stop', goalId: 'g_123', action: 'abandon' }, api, send)
  assert.equal(boards.at(-1), undefined)
  assert.equal(replies.at(-1).result.status, 'abandoned')

  await handleGoalControlRequest({ ...erase, action: 'delete' }, api, send)
  assert.ok(replies.at(-1).error)
  await handleGoalControlRequest(erase, null, send)
  assert.match(replies.at(-1).error, /disabled/)
})
