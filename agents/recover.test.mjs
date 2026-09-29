import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from './store.mjs'
import { createApprovals } from './approvals.mjs'
import { recover } from './recover.mjs'
import { paMirror } from './mirror.mjs'

test('interrupted tasks are re-queued to resume and stale approvals expire', () => {
  const store = createStore(mkdtempSync(join(tmpdir(), 'agents-rec-')), { workDir: '/work' })
  const approvals = createApprovals(store)
  const g = store.newGoal({ title: 'G', outcome: 'O' })
  const running = store.saveTask({ ...store.newTask({ goalId: g.id, title: 'R', brief: 'b' }), status: 'running', sessionId: 's1' })
  const waiting = store.saveTask({ ...store.newTask({ goalId: g.id, title: 'W', brief: 'b' }), status: 'awaiting_approval' })
  const done = store.saveTask({ ...store.newTask({ goalId: g.id, title: 'D', brief: 'b' }), status: 'done' })
  store.newApproval({ taskId: waiting.id, category: 'money', action: 'pay', detail: 'x' })

  assert.equal(recover(store, approvals), 2)
  assert.equal(store.getTask(running.id).status, 'queued')
  assert.equal(store.getTask(running.id).resume, true)
  assert.equal(store.getTask(waiting.id).status, 'queued')
  assert.equal(store.getTask(waiting.id).resume, false)
  assert.equal(store.getTask(done.id).status, 'done')
  assert.equal(store.listApprovals('pending').length, 0)
  assert.equal(store.listApprovals('expired').length, 1)
})

test('the PA mirror adds new goals and logs finished ones', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'agents-pa-')), 'pa.md')
  const mirror = paMirror(file)
  await mirror.goalCreated({ title: 'Release stealthDash' })
  await mirror.goalDone({ title: 'Release stealthDash' }, 'Tagged v1.0.')
  const text = readFileSync(file, 'utf8')
  assert.match(text, /## Goals\n- Release stealthDash/)
  assert.match(text, /Goal done: Release stealthDash — Tagged v1\.0\./)
})
