import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from './store.mjs'
import { COORDINATOR_PROMPT, createActions, createCoordinator, sdkModel, snapshot } from './coordinator.mjs'

/** Create a temporary store with one goal for coordinator behavior tests. */
function setup(goalExtra = {}) {
  const store = createStore(mkdtempSync(join(tmpdir(), 'agents-coord-')), { workDir: '/work' })
  const goal = store.newGoal({ title: 'Release stealthDash', outcome: 'v1.0 tagged', ...goalExtra })
  return { store, goal }
}

// Checks task creation, same-batch dependency resolution, and goal-kind guidance.
test('plan_tasks creates tasks and resolves dependencies by key', () => {
  const { store, goal } = setup()
  const a = createActions(store, goal.id)
  const msg = a.plan_tasks({ tasks: [
    { key: 'ci', title: 'Add CI', brief: 'Add a CI workflow.', kind: 'code', repo: tmpdir() },
    { key: 'notes', title: 'Release notes', brief: 'Write notes.', kind: 'research', dependsOn: ['ci'] },
    { key: 'launch', title: 'Launch messaging', brief: 'Draft launch messaging.', kind: 'marketing' },
  ] })
  assert.match(msg, /^Created /)
  const [ci, notes, launch] = store.listTasks({ goalId: goal.id }).sort((x, y) => x.created.localeCompare(y.created))
  assert.deepEqual(notes.dependsOn, [ci.id])
  assert.equal(ci.workspace.repo, tmpdir())
  assert.equal(launch.kind, 'marketing')
  assert.equal(store.readEvents().filter((e) => e.type === 'task_queued').length, 3)
  assert.match(COORDINATOR_PROMPT, /marketing: software positioning/)
})

// Ensures invalid kinds, dependencies, paths, and task counts are rejected atomically.
test('plan_tasks refuses bad input without creating anything', () => {
  const { store, goal } = setup({ taskCap: 2 })
  const a = createActions(store, goal.id)
  assert.match(a.plan_tasks({ tasks: [{ key: 'x', title: 'X', brief: 'b', kind: 'magic' }] }), /unknown kind/)
  assert.match(a.plan_tasks({ tasks: [{ key: 'x', title: 'X', brief: 'b', kind: 'research', dependsOn: ['nope'] }] }), /unknown dependency/)
  assert.match(a.plan_tasks({ tasks: [{ key: 'x', title: 'X', brief: 'b', kind: 'code', repo: 'relative/path' }] }), /absolute path/)
  assert.match(a.plan_tasks({ tasks: [1, 2, 3].map((number) => {
    // Generate a task batch that exceeds the configured goal cap.
    return { key: `k${number}`, title: `T${number}`, brief: 'b', kind: 'research' }
  }) }), /at most 2 tasks/)
  assert.equal(store.listTasks().length, 0)
})

// Verifies retry limits and task-state restrictions for coordinator updates.
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

// Checks completion guards, persistence, event reporting, and recurring-goal refusal.
test('complete_goal needs every task closed and never completes a recurring goal', () => {
  const { store, goal } = setup()
  const done = []
  // Capture the mirrored completion notice emitted after the goal is saved.
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

// Confirms escalation pauses the goal and marks that the user must respond.
test('escalate pauses the goal and says why', () => {
  const { store, goal } = setup()
  createActions(store, goal.id).escalate({ reason: 'Which repo?' })
  assert.equal(store.getGoal(goal.id).status, 'paused')
  const ev = store.readEvents().at(-1)
  assert.equal(ev.type, 'goal_paused')
  assert.equal(ev.data.reason, 'Which repo?')
  assert.equal(ev.data.awaitingResponse, true)
})

// Verifies the coordinator prompt snapshot includes compact goal and task state.
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

// Checks creation, user redirects, and the active-goal guard around coordinator passes.
test('plan and review run the model with the snapshot; inactive goals are skipped', async () => {
  const { store, goal } = setup()
  const prompts = []
  const coordinator = createCoordinator({
    store,
    // Record prompts and exercise the note tool without invoking a model.
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

// Detects repeated identical plans and verifies their new tasks are cancelled.
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
  const repeat = store.listTasks({ goalId: goal.id }).find((task) => {
    // Select the task created by the repeated plan, not the original failed task.
    return task.id !== first.id
  })
  assert.equal(repeat.status, 'cancelled')
  assert.equal(store.readEvents().at(-1).type, 'goal_paused')
})

// Ensures failed coordinator passes are observable and remain rejectable by callers.
test('a model failure is recorded as an event and rethrown', async () => {
  const { store, goal } = setup()
  const coordinator = createCoordinator({ store, runModel: async () => { throw new Error('overloaded') } })
  await assert.rejects(coordinator.plan(goal.id), /overloaded/)
  assert.equal(store.readEvents().at(-1).type, 'coordinator_error')
})

// Validates SDK budget configuration and usage persistence for a capped result.
test('coordinator caps each pass and records cache usage even when the cap is hit', async () => {
  const { store, goal } = setup()
  const runModel = sdkModel({
    // Stub the SDK query while preserving its async result-stream contract.
    queryFn: ({ options }) => {
      assert.equal(options.maxBudgetUsd, 1)
      return (async function* () {
        yield {
          type: 'result', subtype: 'error_max_budget_usd', total_cost_usd: 1.1,
          modelUsage: { opus: { inputTokens: 4, outputTokens: 5, cacheReadInputTokens: 700, cacheCreationInputTokens: 600 } },
        }
      })()
    },
  })
  await assert.rejects(createCoordinator({ store, runModel }).plan(goal.id), /error_max_budget_usd/)
  assert.deepEqual(store.readEvents().find((e) => e.type === 'coordinator_usage').data, {
    costUsd: 1.1, inputTokens: 4, outputTokens: 5, cacheReadInputTokens: 700, cacheCreationInputTokens: 600,
  })
})

// Confirms archived work is omitted from planning capacity and coordinator context.
test('F11: archived tasks do not count against the cap or appear in the snapshot', () => {
  const { store, goal } = setup({ taskCap: 2 })
  for (let i = 0; i < 3; i++) {
    const t = store.newTask({ goalId: goal.id, title: `Old run ${i}`, brief: 'b' })
    store.saveTask({ ...t, status: 'done', archived: true })
  }
  assert.doesNotMatch(snapshot(store, goal.id, { type: 'task_done', text: 'x' }), /Old run/)
  assert.match(createActions(store, goal.id).plan_tasks({ tasks: [{ key: 'a', title: 'New', brief: 'b', kind: 'research' }] }), /^Created/)
})
