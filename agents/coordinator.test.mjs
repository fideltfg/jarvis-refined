import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from './store.mjs'
import { createActions, createCoordinator, snapshot } from './coordinator.mjs'

function setup(goalExtra = {}) {
  const store = createStore(mkdtempSync(join(tmpdir(), 'agents-coord-')), { workDir: '/work' })
  const goal = store.newGoal({ title: 'Release stealthDash', outcome: 'v1.0 tagged', ...goalExtra })
  return { store, goal }
}

test('plan_tasks creates tasks and resolves dependencies by key', () => {
  const { store, goal } = setup()
  const a = createActions(store, goal.id)
  const msg = a.plan_tasks({ tasks: [
    { key: 'ci', title: 'Add CI', brief: 'Add a CI workflow.', kind: 'code', repo: tmpdir() },
    { key: 'notes', title: 'Release notes', brief: 'Write notes.', kind: 'research', dependsOn: ['ci'] },
  ] })
  assert.match(msg, /^Created /)
  const [ci, notes] = store.listTasks({ goalId: goal.id }).sort((x, y) => x.created.localeCompare(y.created))
  assert.deepEqual(notes.dependsOn, [ci.id])
  assert.equal(ci.workspace.repo, tmpdir())
  assert.equal(store.readEvents().filter((e) => e.type === 'task_queued').length, 2)
})

test('plan_tasks refuses bad input without creating anything', () => {
  const { store, goal } = setup({ taskCap: 2 })
  const a = createActions(store, goal.id)
  assert.match(a.plan_tasks({ tasks: [{ key: 'x', title: 'X', brief: 'b', kind: 'magic' }] }), /unknown kind/)
  assert.match(a.plan_tasks({ tasks: [{ key: 'x', title: 'X', brief: 'b', kind: 'research', dependsOn: ['nope'] }] }), /unknown dependency/)
  assert.match(a.plan_tasks({ tasks: [{ key: 'x', title: 'X', brief: 'b', kind: 'code', repo: 'relative/path' }] }), /absolute path/)
  assert.match(a.plan_tasks({ tasks: [1, 2, 3].map((n) => ({ key: `k${n}`, title: `T${n}`, brief: 'b', kind: 'research' })) }), /at most 2 tasks/)
  assert.equal(store.listTasks().length, 0)
})

test('update_task retries only failed or blocked tasks with attempts left', () => {
  const { store, goal } = setup()
  const a = createActions(store, goal.id)
  const t = store.newTask({ goalId: goal.id, title: 'T', brief: 'b' })
  assert.match(a.update_task({ taskId: t.id, status: 'queued' }), /only a failed or blocked task/)
  store.saveTask({ ...t, status: 'failed', attempts: 1 })
  assert.match(a.update_task({ taskId: t.id, status: 'queued', brief: 'try harder' }), /Updated/)
  assert.equal(store.getTask(t.id).status, 'queued')
  assert.equal(store.getTask(t.id).brief, 'try harder')
  store.saveTask({ ...store.getTask(t.id), status: 'failed', attempts: 3 })
  assert.match(a.update_task({ taskId: t.id, status: 'queued' }), /all 3 attempts/)
  assert.match(a.update_task({ taskId: 't_other', status: 'queued' }), /No task/)
})

test('complete_goal needs every task closed and never completes a recurring goal', () => {
  const { store, goal } = setup()
  const done = []
  const a = createActions(store, goal.id, { mirror: { goalDone: (g, s) => done.push([g.id, s]) } })
  const t = store.newTask({ goalId: goal.id, title: 'T', brief: 'b' })
  assert.match(a.complete_goal({ summary: 'Shipped.' }), /still open/)
  store.saveTask({ ...t, status: 'done' })
  assert.match(a.complete_goal({ summary: 'Shipped.' }), /done/)
  assert.equal(store.getGoal(goal.id).status, 'done')
  assert.deepEqual(done, [[goal.id, 'Shipped.']])
  assert.equal(store.readEvents().at(-1).type, 'goal_done')

  const r = setup({ recurring: { every: '6h' } })
  assert.match(createActions(r.store, r.goal.id).complete_goal({ summary: 'x' }), /never completes/)
})

test('escalate pauses the goal and says why', () => {
  const { store, goal } = setup()
  createActions(store, goal.id).escalate({ reason: 'Which repo?' })
  assert.equal(store.getGoal(goal.id).status, 'paused')
  const ev = store.readEvents().at(-1)
  assert.equal(ev.type, 'goal_paused')
  assert.equal(ev.data.reason, 'Which repo?')
})

test('the snapshot shows the goal, tasks, results and trigger', () => {
  const { store, goal } = setup()
  const t = store.newTask({ goalId: goal.id, title: 'Add CI', brief: 'b' })
  store.saveTask({ ...t, status: 'failed', attempts: 1, failure: { reason: 'budget', detail: 'Used all 30 turns.' } })
  const s = snapshot(store, goal.id, { type: 'task_failed', text: 'Task failed: Add CI' })
  assert.match(s, /GOAL .*Release stealthDash/)
  assert.match(s, /Done means: v1.0 tagged/)
  assert.match(s, /\[failed: budget, attempts 1\/3\]/)
  assert.match(s, /Used all 30 turns/)
  assert.match(s, /TRIGGER: Task failed: Add CI/)
})

test('plan and review run the model with the snapshot; inactive goals are skipped', async () => {
  const { store, goal } = setup()
  const prompts = []
  const coordinator = createCoordinator({
    store,
    runModel: async ({ prompt, actions }) => {
      prompts.push(prompt)
      actions.note({ text: 'Planned.' })
    },
  })
  await coordinator.plan(goal.id)
  assert.match(prompts[0], /just created/)
  assert.equal(store.getGoal(goal.id).notes, 'Planned.')
  await coordinator.redirect(goal.id, 'Use the beta branch')
  assert.match(prompts[1], /The user says: Use the beta branch/)
  store.saveGoal({ ...store.getGoal(goal.id), status: 'paused' })
  await coordinator.review(goal.id, { type: 'task_done', text: 'x' })
  assert.equal(prompts.length, 2)
})

test('the same plan twice with no progress pauses the goal and cancels the repeat', async () => {
  const { store, goal } = setup()
  const coordinator = createCoordinator({
    store,
    runModel: async ({ actions }) => {
      actions.plan_tasks({ tasks: [{ key: 'a', title: 'Try it', brief: 'b', kind: 'research' }] })
    },
  })
  await coordinator.plan(goal.id)
  const first = store.listTasks({ goalId: goal.id })[0]
  store.saveTask({ ...first, status: 'failed', attempts: 1 })
  await coordinator.review(goal.id, { type: 'task_failed', text: 'x' })
  assert.equal(store.getGoal(goal.id).status, 'paused')
  const repeat = store.listTasks({ goalId: goal.id }).find((t) => t.id !== first.id)
  assert.equal(repeat.status, 'cancelled')
  assert.equal(store.readEvents().at(-1).type, 'goal_paused')
})

test('a model failure is recorded as an event and rethrown', async () => {
  const { store, goal } = setup()
  const coordinator = createCoordinator({ store, runModel: async () => { throw new Error('overloaded') } })
  await assert.rejects(coordinator.plan(goal.id), /overloaded/)
  assert.equal(store.readEvents().at(-1).type, 'coordinator_error')
})

test('F11: archived tasks do not count against the cap or appear in the snapshot', () => {
  const { store, goal } = setup({ taskCap: 2 })
  for (let i = 0; i < 3; i++) {
    const t = store.newTask({ goalId: goal.id, title: `Old run ${i}`, brief: 'b' })
    store.saveTask({ ...t, status: 'done', archived: true })
  }
  assert.doesNotMatch(snapshot(store, goal.id, { type: 'task_done', text: 'x' }), /Old run/)
  assert.match(createActions(store, goal.id).plan_tasks({ tasks: [{ key: 'a', title: 'New', brief: 'b', kind: 'research' }] }), /^Created/)
})
