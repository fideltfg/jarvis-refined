import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createAnnouncer, phrase, spoken } from './announce.ts'

const ev = (type, data = {}, text = '') => ({ at: '2026-09-29T00:00:00Z', type, text, data })

test('only endings, blockers and approvals are spoken', () => {
  for (const t of ['task_done', 'task_failed', 'task_blocked', 'goal_done', 'goal_paused', 'approval_needed']) {
    assert.ok(spoken(ev(t)), t)
  }
  for (const t of ['task_started', 'task_progress', 'tool_call', 'task_queued', 'goal_changed', 'task_cancelled']) {
    assert.ok(!spoken(ev(t)), t)
  }
})

test('single events use the theme register', () => {
  assert.equal(phrase([ev('task_done', { title: 'CI pipeline' })], 'lcars'), 'Task complete: CI pipeline.')
  assert.equal(phrase([ev('task_done', { title: 'CI pipeline' })], 'stark'), 'CI pipeline is finished.')
  assert.equal(phrase([ev('approval_needed', { action: 'git force-push' })], 'stark'), 'An agent needs your approval to git force-push.')
  assert.equal(phrase([ev('approval_needed', { action: 'git force-push' })], 'hal'), 'Authorisation required: git force-push.')
  assert.equal(phrase([ev('goal_paused', { title: 'Release' })], 'wopr'), 'Goal suspended: Release. Input required.')
})

test('bursts are merged by kind, and approvals are counted', () => {
  const batch = [ev('task_done', { title: 'A' }), ev('task_done', { title: 'B' }), ev('approval_needed', { action: 'x' }), ev('approval_needed', { action: 'y' })]
  assert.equal(phrase(batch, 'lcars'), '2 tasks complete. 2 authorisations required.')
  assert.equal(phrase(batch, 'stark'), '2 tasks are finished. 2 approvals are waiting for you.')
})

test('the announcer merges a burst, waits for idle, and ignores silent events', async () => {
  const said = []
  const timers = []
  let idle = false
  const a = createAnnouncer({
    theme: 'lcars',
    idle: () => idle,
    say: async (text) => { said.push(text) },
    schedule: (fn) => { timers.push(fn) },
  })
  a.push(ev('task_progress'))
  assert.equal(timers.length, 0)
  a.push(ev('task_done', { title: 'A' }))
  a.push(ev('task_done', { title: 'B' }))
  assert.equal(timers.length, 1)
  await timers.shift()()
  assert.deepEqual(said, [])
  assert.equal(timers.length, 1)
  idle = true
  await timers.shift()()
  assert.deepEqual(said, ['2 tasks complete.'])
})
