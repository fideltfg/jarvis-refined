import { test } from 'node:test'
import assert from 'node:assert/strict'

import { agentSummary, capacityLine, deleteBlockReason, mainTaskRows, mergeBoard, mergeBoardData, runningAgents, stateGroup, statusLabel } from './board.ts'

const task = (over = {}) => ({
  id: 't1', title: 'Task', kind: 'shell', status: 'queued', attempts: 1, summary: null,
  created: '2026-09-29T00:00:00Z', updated: '2026-09-29T00:00:00Z', ...over,
})

const goal = (over = {}) => ({
  id: 'g1', title: 'Goal', outcome: 'Something', status: 'active', priority: 1,
  created: '2026-09-29T00:00:00Z', tasks: [], ...over,
})

const board = (over = {}) => ({ goals: [], approvals: [], running: [], ...over })

const sub = (over = {}) => ({
  id: 's1', title: 'Find the parser', kind: 'Explore', status: 'running',
  startedAt: '2026-09-29T01:00:00Z', summary: null, ...over,
})

test('both sources land in one list with one shape', () => {
  const rows = mergeBoard(board({ goals: [goal({ tasks: [task()] })] }), [sub()])

  assert.equal(rows.length, 3)
  assert.deepEqual([...new Set(rows.map((r) => r.kind))].sort(), ['goal', 'subagent', 'task'])
  // The point of the unification: every row answers the same four questions.
  for (const row of rows) {
    assert.equal(typeof row.name, 'string')
    assert.equal(typeof row.status, 'string')
    assert.equal(typeof row.activity, 'string')
    assert.ok('result' in row)
  }
})

test('a subagent carries its brief, its type and its result', () => {
  const [row] = mergeBoard(null, [
    sub({ status: 'done', summary: 'Parser lives in src/lib/parse.ts', finishedAt: '2026-09-29T01:02:00Z' }),
  ])

  assert.equal(row.kind, 'subagent')
  assert.equal(row.name, 'Find the parser')
  assert.equal(row.activity, 'Explore')
  assert.equal(row.status, 'done')
  assert.equal(row.result, 'Parser lives in src/lib/parse.ts')
  assert.equal(row.parentId, null)
})

test('every agent belongs to JARVIS and says which provider carries it', () => {
  const rows = mergeBoard(
    board({
      goals: [goal({
        tasks: [
          task({ id: 'a', status: 'running', model: 'sonnet', runtime: { endpointId: 'anthropic', label: 'Anthropic', provider: 'anthropic', model: 'sonnet', startedAt: '2026-09-29T02:00:00Z' } }),
          task({ id: 'b', status: 'running', runtime: { endpointId: 'rigel', label: 'Rigel', provider: 'remote', model: null } }),
          task({ id: 'c', model: 'opus' }),
          task({ id: 'd', origin: { label: 'vega' } }),
        ],
      })],
    }),
    [sub({ provider: 'claude', model: 'claude-opus-5', brief: 'Find where parsing happens.' })],
  )
  const by = Object.fromEntries(rows.map((row) => [row.id, row]))

  assert.ok(rows.every((row) => row.owner === 'JARVIS'))
  assert.equal(by.a.runsOn, 'Anthropic')
  assert.equal(by.a.startedAt, '2026-09-29T02:00:00Z', 'a task is timed from when it began running')
  assert.equal(by.a.goal, 'Goal')
  assert.equal(by.b.runsOn, 'Remote host · Rigel')
  assert.equal(by.c.runsOn, null, 'not yet placed')
  assert.equal(by.c.model, 'opus')
  assert.equal(by.d.runsOn, 'delegated by vega')
  assert.equal(by.s1.runsOn, 'Claude session')
  assert.equal(by.s1.model, 'claude-opus-5')
  assert.equal(by.s1.brief, 'Find where parsing happens.')

  assert.deepEqual(runningAgents(rows).map((row) => row.id).sort(), ['a', 'b', 's1'])
  assert.equal(agentSummary(rows), '3 running · 2 queued')
})

test('subagents show even with the agent service offline', () => {
  const rows = mergeBoard(null, [sub()])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'running')
})

test('a task stays under its own goal', () => {
  const rows = mergeBoard(board({ goals: [goal({ tasks: [task({ id: 'a' }), task({ id: 'b' })] })] }))

  assert.deepEqual(rows.map((r) => r.kind), ['goal', 'task', 'task'])
  assert.deepEqual(rows.slice(1).map((r) => r.parentId), ['g1', 'g1'])
})

test('decision questions and document references stay attached to their task', () => {
  const questions = [{ id: 'region', prompt: 'Choose a region', options: [{ id: 'east', label: 'East' }, { id: 'west', label: 'West' }] }]
  const references = [{ title: 'Regional notes', path: 'reports/regions.md' }]
  const rows = mergeBoard(board({ goals: [goal({ tasks: [task({ status: 'blocked', failure: { blocker: 'decision', questions }, references })] })] }))
  assert.deepEqual(rows[1].questions, questions)
  assert.deepEqual(rows[1].references, references)
})

test('one board keeps saved goals and overlays newer live task state', () => {
  const history = board({ goals: [
    goal({ id: 'g-live', title: 'Live goal', tasks: [task({ id: 't-live', status: 'done', summary: 'Saved result' }), task({ id: 't-old', status: 'done' })] }),
    goal({ id: 'g-done', title: 'Completed goal', status: 'done' }),
  ] })
  const current = board({ goals: [
    goal({ id: 'g-live', title: 'Live goal', tasks: [task({ id: 't-live', status: 'running', summary: null })] }),
  ], capacity: { capacity: 3, running: 1, endpoints: [] } })
  const merged = mergeBoardData(current, history)
  assert.deepEqual(merged.goals.map((entry) => entry.id), ['g-live', 'g-done'])
  assert.deepEqual(merged.goals[0].tasks.map((entry) => [entry.id, entry.status]), [['t-live', 'running'], ['t-old', 'done']])
  assert.equal(merged.goals[1].status, 'done')
  assert.equal(merged.capacity.running, 1)
})

test('main task results use coordinator notes and hide worker and session results', () => {
  const rows = mergeBoard(board({ goals: [goal({ notes: 'Release is ready for approval.', tasks: [task({ status: 'done', summary: 'Verbose worker output' })] })] }), [sub({ status: 'done', summary: 'Session output' })])
  const visible = mainTaskRows(rows)
  assert.deepEqual(visible.map((row) => row.id), ['g1'])
  assert.equal(visible[0].result, 'Release is ready for approval.')
  assert.equal(mainTaskRows(mergeBoard(board({ goals: [goal()] })))[0].result, null)
})

test('main task view retains actionable blockers and approvals, not worker results', () => {
  const approval = { id: 'ap1', taskId: 'approval', category: 'shell', action: 'publish', detail: 'command' }
  const rows = mergeBoard(board({ goals: [goal({ tasks: [task({ id: 'blocked', status: 'blocked' }), task({ id: 'approval', status: 'awaiting_approval' }), task({ id: 'running', status: 'running' })] })], approvals: [approval] }))
  assert.deepEqual(mainTaskRows(rows).map((row) => row.id), ['g1', 'blocked', 'approval'])
  assert.equal(mainTaskRows(rows)[2].approval, approval)
})

test('the merged main and child rows preserve explicit response-needed state', () => {
  const rows = mergeBoard(board({ goals: [goal({ awaitingResponse: true, tasks: [task({ status: 'blocked', awaitingResponse: true })] })] }))
  assert.equal(rows[0].awaitingResponse, true)
  assert.equal(rows[1].awaitingResponse, true)
  assert.equal(mergeBoard(null, [sub()])[0].awaitingResponse, false)
})

test('the most urgent unit comes first, whatever kind it is', () => {
  const rows = mergeBoard(
    board({
      goals: [goal({ tasks: [task({ status: 'awaiting_approval' })] })],
      approvals: [{ id: 'ap1', taskId: 't1', category: 'shell', action: 'rm -rf', detail: '' }],
    }),
    [sub({ status: 'done', finishedAt: '2026-09-29T09:00:00Z' })],
  )

  // The approval outranks a subagent that finished more recently.
  assert.equal(rows[0].kind, 'goal')
  assert.equal(rows[1].status, 'awaiting_approval')
  assert.equal(rows.at(-1).kind, 'subagent')
})

test('an approval is attached to the task it blocks', () => {
  const approval = { id: 'ap1', taskId: 't1', category: 'shell', action: 'force-push', detail: 'd' }
  const rows = mergeBoard(
    board({ goals: [goal({ tasks: [task({ status: 'awaiting_approval' }), task({ id: 't2' })] })], approvals: [approval] }),
  )

  assert.equal(rows.find((r) => r.id === 't1').approval, approval)
  assert.equal(rows.find((r) => r.id === 't2').approval, null)
  assert.equal(rows.find((r) => r.kind === 'goal').approval, null)
})

test('a goal reports progress and what its tasks are doing', () => {
  const rows = mergeBoard(
    board({
      goals: [goal({ tasks: [task({ id: 'a', status: 'done' }), task({ id: 'b', status: 'running' })] })],
    }),
  )
  const [goalRow] = rows

  assert.equal(goalRow.progress, 0.5)
  assert.equal(goalRow.activity, '1 of 2 tasks done · 1 running')
  assert.equal(goalRow.status, 'active')
})

test('cancelled tasks leave the board and the arithmetic', () => {
  const rows = mergeBoard(
    board({ goals: [goal({ tasks: [task({ id: 'a', status: 'done' }), task({ id: 'b', status: 'cancelled' })] })] }),
  )

  assert.deepEqual(rows.map((r) => r.id), ['g1', 'a'])
  assert.equal(rows[0].progress, 1)
  assert.equal(rows[0].activity, '1 of 1 task done')
})

test('a paused goal says so', () => {
  const [row] = mergeBoard(board({ goals: [goal({ status: 'paused' })] }))
  assert.equal(row.status, 'paused')
  assert.equal(row.progress, 0)
})

test('history recalls cancelled tasks and keeps completed goals terminal', () => {
  const rows = mergeBoard(board({ goals: [goal({ status: 'done', tasks: [task({ status: 'cancelled' })] })] }), [], { history: true })
  assert.equal(rows[0].status, 'done')
  assert.equal(rows[1].status, 'cancelled')
  assert.equal(rows[0].progress, 0)
  assert.equal(mergeBoard(board({ goals: [goal({ status: 'abandoned' })] }))[0].status, 'cancelled')
})

test('attempts only surface once something has gone wrong', () => {
  const plain = mergeBoard(board({ goals: [goal({ tasks: [task({ kind: 'shell' })] })] }))
  assert.equal(plain[1].activity, 'shell')

  const retried = mergeBoard(board({ goals: [goal({ tasks: [task({ kind: 'shell', attempts: 3 })] })] }))
  assert.equal(retried[1].activity, 'shell · attempt 3')
})

test('an empty board is an empty list, not a crash', () => {
  assert.deepEqual(mergeBoard(null), [])
  assert.deepEqual(mergeBoard(null, []), [])
  assert.deepEqual(mergeBoard(board()), [])
})

test('every status has a label', () => {
  for (const s of ['awaiting_approval', 'blocked', 'running', 'queued', 'active', 'paused', 'failed', 'done', 'cancelled']) {
    assert.equal(typeof statusLabel(s), 'string')
  }
  assert.equal(statusLabel('awaiting_approval'), 'approval')
})

// -- the capacity line ------------------------------------------------------

const ep = (over = {}) => ({
  id: 'cloud', label: 'cloud', kind: 'anthropic', model: null,
  healthy: true, running: 0, concurrency: 2, kinds: [], ...over,
})

test('one idle endpoint says nothing, because there is nothing to choose', () => {
  assert.equal(capacityLine(null), null)
  assert.equal(capacityLine(undefined), null)
  // An older agent service with no /endpoints route.
  assert.equal(capacityLine({ capacity: null, running: 0, endpoints: [] }), null)
  assert.equal(capacityLine({ capacity: 3, running: 0, endpoints: [ep()] }), null)
})

test('one endpoint with work on it reports the load', () => {
  assert.equal(capacityLine({ capacity: 3, running: 2, endpoints: [ep({ running: 2 })] }), '2 of 3 busy')
})

test('several endpoints are always worth a line, idle or not', () => {
  const line = capacityLine({
    capacity: 4, running: 1,
    endpoints: [ep({ running: 1 }), ep({ id: 'rigel', kind: 'gateway', concurrency: 2 })],
  })
  assert.equal(line, '1 of 4 busy · 2 endpoints')
})

test('an unreachable machine is counted on the line', () => {
  const line = capacityLine({
    capacity: 6, running: 0,
    endpoints: [ep(), ep({ id: 'rigel', healthy: false }), ep({ id: 'vega', healthy: false })],
  })
  assert.equal(line, '0 of 6 busy · 3 endpoints · 2 down')
})

test('every board status falls in exactly one roster group, and only idle ones are idle', () => {
  const groups = {}
  for (const status of ['awaiting_approval', 'blocked', 'running', 'queued', 'active', 'paused', 'failed', 'interrupted', 'done', 'cancelled']) {
    groups[status] = stateGroup({ kind: 'goal', id: 'g1', name: 'Goal', status })
  }
  assert.deepEqual(groups, {
    awaiting_approval: 'waiting', blocked: 'waiting',
    running: 'working', queued: 'working', active: 'working',
    paused: 'paused',
    failed: 'idle', interrupted: 'idle', done: 'idle', cancelled: 'idle',
  })
})

test('only an idle goal may be deleted, and the refusal says why', () => {
  const row = (over) => ({ kind: 'goal', id: 'g1', name: 'Ship it', status: 'done', ...over })

  for (const status of ['done', 'failed', 'cancelled', 'interrupted']) {
    assert.equal(deleteBlockReason(row({ status })), null, `${status} should be deletable`)
  }
  // Anything still live is refused here as well as in the service, so the
  // board never offers a button that is bound to fail.
  for (const status of ['active', 'running', 'queued', 'blocked', 'awaiting_approval', 'paused']) {
    const reason = deleteBlockReason(row({ status }))
    assert.ok(reason, `${status} should be refused`)
    assert.match(reason, /Ship it/)
    assert.match(reason, new RegExp(statusLabel(status)))
  }
  assert.match(deleteBlockReason(row({ kind: 'task' })), /removed with the agent/)
  assert.match(deleteBlockReason(row({ kind: 'subagent' })), /no saved record/)
  assert.match(deleteBlockReason(undefined), /Select an agent/)
  assert.match(deleteBlockReason(null), /Select an agent/)
})

test('the roster groups a merged board the same way the delete guard reads it', () => {
  const rows = mergeBoard(board({ goals: [
    goal({ id: 'g_live', status: 'active', tasks: [task({ id: 't_live', status: 'running' })] }),
    goal({ id: 'g_done', status: 'done', tasks: [task({ id: 't_done', status: 'done' })] }),
  ] }), [], { history: true })
  const done = rows.find((entry) => entry.id === 'g_done')
  const live = rows.find((entry) => entry.id === 'g_live')
  assert.equal(stateGroup(done), 'idle')
  assert.equal(deleteBlockReason(done), null)
  assert.notEqual(stateGroup(live), 'idle')
  assert.ok(deleteBlockReason(live))
})
