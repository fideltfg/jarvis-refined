import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRemoteApi } from './api.mjs'

/** Run a request against an ephemeral authenticated remote API instance. */
async function withApi(run) {
  const state = { tasks: [], decisions: [] }
  const store = {
    /** Return no pending approvals for the unrelated listing route. */
    listApprovals() { return [] },
    /** Treat the fixture's approval as belonging to delegated work. */
    getTask() { return { delegated: true } },
    /** Resolve the fixture approval id. */
    getApproval(id) { return { id, taskId: 't_remote' } },
    /** Start with no idempotency match for the submitted task. */
    listTasks() { return [] },
    /** Force task creation to exercise the POST body path. */
    listGoals() { return [] },
    /** Supply a stable delegated goal for the task fixture. */
    newGoal() { return { id: 'g_remote' } },
    /** Accept the goal persistence call made during task creation. */
    saveGoal() {},
    /** Supply a stable task id for the task fixture. */
    newTask() { return { id: 't_created' } },
    /** Capture the complete task record for assertions. */
    saveTask(task) { state.tasks.push(task) },
    /** Accept the queue event emitted after task persistence. */
    appendEvent() {},
  }
  const api = createRemoteApi({
    store,
    // Supply the scheduler read/cancel surface used by task endpoints.
    scheduler: { running: () => new Map(), cancel: () => true },
    // Capture the decision so the approval route's parsed fields are observable.
    approvals: { decide: (id, decision, note) => {
      const result = { id, decision, note }
      state.decisions.push(result)
      return result
    } },
    token: 'test-token',
  })
  const port = await api.listen()
  try {
    await run({ port, state })
  } finally {
    await api.close()
  }
}

// Validates shared body parsing before delegated task data is persisted.
test('task creation reads bounded JSON and saves the delegated task', async () => {
  // Use the actual HTTP boundary so request streaming and JSON decoding are covered.
  await withApi(async ({ port, state }) => {
    const response = await fetch(`http://127.0.0.1:${port}/tasks`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'research',
        title: 'Collect findings',
        brief: 'Research the requested topic.',
        origin: { label: 'local', taskId: 't_origin' },
      }),
    })

    assert.equal(response.status, 201)
    assert.deepEqual(await response.json(), { id: 't_created', goalId: 'g_remote' })
    assert.equal(state.tasks[0].delegated, true)
    assert.equal(state.tasks[0].origin.taskId, 't_origin')
  })
})

// Validates approval JSON parsing and the shared request-size rejection.
test('approval decisions parse JSON and reject oversized request bodies', async () => {
  // Exercise both valid approval data and the same body-size gate used by task creation.
  await withApi(async ({ port, state }) => {
    const headers = { authorization: 'Bearer test-token', 'content-type': 'application/json' }
    const response = await fetch(`http://127.0.0.1:${port}/approvals/a_review`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ decision: 'approve', note: 'Reviewed' }),
    })

    assert.equal(response.status, 200)
    assert.deepEqual(state.decisions, [{ id: 'a_review', decision: 'approve', note: 'Reviewed' }])

    const oversized = await fetch(`http://127.0.0.1:${port}/approvals/a_review`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ decision: 'deny', note: 'x'.repeat(64 * 1024) }),
    })

    assert.equal(oversized.status, 400)
    assert.deepEqual(await oversized.json(), { error: 'Request too large.' })
  })
})