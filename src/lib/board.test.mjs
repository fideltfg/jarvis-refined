import { test } from 'node:test'
import assert from 'node:assert/strict'

import { mergeBoard, statusLabel } from './board.ts'

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
