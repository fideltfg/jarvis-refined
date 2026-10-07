import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectStartupStatus, handleStartupStatusRequest, mergeSessionAgents } from './startup-status.mjs'
import { boardOf } from '../agents/briefing.mjs'

function sources(overrides = {}) {
  return {
    api: {
      board: async () => ({ goals: [{ id: 'complete', status: 'done', tasks: [{ status: 'done', summary: 'Published result' }] }], running: [] }),
      schedules: async () => [{ title: 'Documentation review', nextRunAt: '2026-10-07T02:00:00Z' }],
      endpoints: async () => ({ endpoints: [{ id: 'remote', healthy: false, running: 0 }] }),
    },
    readMemory: () => ({ tasks: [{ text: 'Follow up deployment' }], focus: 'Jarvis' }),
    readLooseEnds: () => ({ items: [{ action: 'Verify release', status: 'partial' }] }),
    readSessionAgents: () => [{ title: 'Research', status: 'interrupted' }],
    ...overrides,
  }
}

test('startup collects independent authoritative sources without model interpretation', async () => {
  const result = await collectStartupStatus(sources())
  assert.equal(result.board.goals[0].tasks[0].summary, 'Published result')
  assert.equal(result.schedules[0].title, 'Documentation review')
  assert.equal(result.capacity.endpoints[0].healthy, false)
  assert.equal(result.memory.tasks[0].text, 'Follow up deployment')
  assert.equal(result.looseEnds.items[0].status, 'partial')
  assert.equal(result.sessionAgents[0].status, 'interrupted')
  assert.deepEqual(result.errors, [])
})

test('startup reports partial outages instead of claiming no work exists', async () => {
  const result = await collectStartupStatus(sources({ api: null, readMemory: () => { throw new Error('Cannot read memory') } }))
  assert.equal(result.board, null)
  assert.equal(result.schedules, null)
  assert.equal(result.memory, null)
  assert.equal(result.looseEnds.items.length, 1)
  assert.deepEqual(result.errors.map(error => error.source).sort(), ['background agents', 'personal tasks', 'remote endpoints', 'scheduled work'])
})

test('startup status requests are correlated and invalid requests read nothing', async () => {
  const replies = []
  const dependencies = sources()
  assert.equal(await handleStartupStatusRequest({ type: 'ask' }, dependencies, reply => replies.push(reply)), false)
  assert.equal(await handleStartupStatusRequest({ type: 'startup_status' }, {}, reply => replies.push(reply)), true)
  assert.equal(replies.length, 0)
  await handleStartupStatusRequest({ type: 'startup_status', requestId: 'startup-one' }, dependencies, reply => replies.push(reply))
  assert.equal(replies[0].type, 'startup_status_reply')
  assert.equal(replies[0].requestId, 'startup-one')
  assert.equal(replies[0].snapshot.schedules.length, 1)
})

test('live subagent tracking wins over interrupted copies loaded from disk', () => {
  const saved = { id: 'one', title: 'Research', status: 'interrupted', live: false, startedAt: '2026-10-07T00:00:00Z' }
  const live = { ...saved, status: 'running', live: true }
  assert.deepEqual(mergeSessionAgents([[live], [saved]]), [live])
  assert.deepEqual(mergeSessionAgents([[saved], [live]]), [live])
})

test('history-inclusive boards preserve completed goals, remote assignment, results, and progress', () => {
  const task = { id: 'task', goalId: 'goal', title: 'Research', status: 'done', archived: true, created: '2026-10-07', updated: '2026-10-07', remote: { endpointId: 'remote-one', taskId: 'remote-task', token: 'must-not-leak' }, workspace: { path: '/work/result' }, result: { summary: 'Finished report' } }
  const store = {
    listTasks: () => [task], listGoals: () => [{ id: 'goal', title: 'Completed work', status: 'done', priority: 1, created: '2026-10-07' }],
    listSchedules: () => [], listApprovals: () => [], readEvents: () => [{ taskId: 'task', type: 'task_progress', text: 'Saved report', at: '2026-10-07' }],
  }
  assert.equal(boardOf(store).goals.length, 0)
  const history = boardOf(store, new Set(), { history: true })
  assert.equal(history.goals[0].tasks[0].summary, 'Finished report')
  assert.equal(history.goals[0].tasks[0].workspace, '/work/result')
  assert.equal(history.goals[0].tasks[0].archived, true)
  assert.equal(history.goals[0].tasks[0].progress.text, 'Saved report')
  assert.deepEqual(history.goals[0].tasks[0].remote, { endpointId: 'remote-one', taskId: 'remote-task' })
})