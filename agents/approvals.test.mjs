import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from './store.mjs'
import { createApprovals } from './approvals.mjs'
import { createContacts } from './contacts.mjs'

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'agents-appr-'))
  const store = createStore(root, { workDir: '/work' })
  const contacts = createContacts(join(root, 'contacts.json'))
  const approvals = createApprovals(store, { contacts })
  const goal = store.newGoal({ title: 'G', outcome: 'O' })
  const task = store.saveTask({ ...store.newTask({ goalId: goal.id, title: 'Mail Bob', brief: 'b' }), status: 'running' })
  return { root, store, contacts, approvals, task }
}

test('a request pauses the task, records it and resolves when approved', async () => {
  const { store, approvals, task } = setup()
  const pending = approvals.request({ task, category: 'destruction', action: 'git force-push', detail: 'git push -f' })
  assert.equal(store.getTask(task.id).status, 'awaiting_approval')
  const [a] = store.listApprovals('pending')
  assert.equal(a.action, 'git force-push')
  const ev = store.readEvents().find((e) => e.type === 'approval_needed')
  assert.equal(ev.data.approvalId, a.id)
  assert.equal(ev.data.action, 'git force-push')
  assert.equal(ev.data.title, 'Mail Bob')
  approvals.decide(a.id, 'approve')
  assert.deepEqual(await pending, { approved: true, note: null })
  assert.equal(store.getTask(task.id).status, 'running')
  assert.equal(store.getApproval(a.id).status, 'approved')
})

test('a denial carries the note back to the worker', async () => {
  const { store, approvals, task } = setup()
  const pending = approvals.request({ task, category: 'money', action: 'pay', detail: 'x' })
  approvals.decide(store.listApprovals('pending')[0].id, 'deny', 'too expensive')
  assert.deepEqual(await pending, { approved: false, note: 'too expensive' })
})

test('answering the same approval twice fails cleanly the second time', () => {
  const { store, approvals, task } = setup()
  void approvals.request({ task, category: 'money', action: 'pay', detail: 'x' })
  const id = store.listApprovals('pending')[0].id
  approvals.decide(id, 'approve')
  assert.throws(() => approvals.decide(id, 'deny'), /already approved/)
  assert.throws(() => approvals.decide('a_missing', 'approve'), /No approval/)
  assert.throws(() => approvals.decide(id, 'maybe'), /approve or deny/)
})

test('approving a new contact remembers them', () => {
  const { root, store, approvals, contacts, task } = setup()
  void approvals.request({ task, category: 'new_contact', action: 'message bob@x.io', detail: 'x', recipients: ['bob@x.io'] })
  approvals.decide(store.listApprovals('pending')[0].id, 'approve')
  assert.ok(contacts.get().has('bob@x.io'))
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'contacts.json'), 'utf8')), ['bob@x.io'])
})

test('expire settles waiting workers as denied and marks the records', async () => {
  const { store, approvals, task } = setup()
  const pending = approvals.request({ task, category: 'money', action: 'pay', detail: 'x' })
  approvals.expire(task.id)
  assert.deepEqual(await pending, { approved: false, note: 'The request expired.' })
  assert.equal(store.listApprovals('expired').length, 1)
})

test('contacts start empty when the file is missing', () => {
  const contacts = createContacts(join(mkdtempSync(join(tmpdir(), 'c-')), 'contacts.json'))
  assert.equal(contacts.get().size, 0)
})
