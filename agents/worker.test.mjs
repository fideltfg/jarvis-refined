import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from './store.mjs'
import { DISALLOWED, runTask, workerPrompt } from './worker.mjs'

function setup(taskExtra = {}) {
  const store = createStore(mkdtempSync(join(tmpdir(), 'agents-worker-')), { workDir: '/work' })
  const goal = store.newGoal({ title: 'Release', outcome: 'Tagged v1' })
  const task = { ...store.newTask({ goalId: goal.id, title: 'Write notes', brief: 'Write release notes.', kind: 'code' }), ...taskExtra }
  return { store, goal, task }
}

const deps = (store, extra = {}) => ({
  store,
  approvals: { request: async () => ({ approved: true, note: null }) },
  contacts: () => new Set(),
  prepare: (t) => t.workspace.path,
  makeReportServer: (onReport) => ({ onReport }),
  ...extra,
})

const fake = (body) => ({ prompt, options }) => body({ prompt, options })
const waitForAbort = (options) =>
  new Promise((resolve) => options.abortController.signal.addEventListener('abort', resolve))

test('a run that reports done returns the result and records the session', async () => {
  const { store, task } = setup()
  const sessions = []
  let seen
  const out = await runTask(task, deps(store, {
    onSession: (s) => sessions.push(s),
    queryFn: fake(async function* ({ prompt, options }) {
      seen = { prompt, options }
      yield { type: 'system', subtype: 'init', session_id: 's1' }
      options.mcpServers.agent.onReport({ status: 'progress', summary: 'Halfway.' })
      options.mcpServers.agent.onReport({ status: 'done', summary: 'Wrote NOTES.md', artifacts: ['NOTES.md'] })
      yield { type: 'result', subtype: 'success', session_id: 's1' }
    }),
  }))
  assert.deepEqual(out, { status: 'done', result: { summary: 'Wrote NOTES.md', artifacts: ['NOTES.md'] } })
  assert.deepEqual(sessions, ['s1'])
  assert.equal(seen.prompt, 'Write release notes.')
  assert.equal(seen.options.model, 'claude-sonnet-5')
  assert.equal(seen.options.maxTurns, 60)
  assert.deepEqual(seen.options.settingSources, [])
  assert.deepEqual(seen.options.disallowedTools, DISALLOWED.code)
  assert.equal(seen.options.cwd, task.workspace.path)
  assert.ok(store.readEvents().some((e) => e.type === 'task_progress' && e.text === 'Halfway.'))
})

test('the gate denies credentials, routes hard stops to approval and allows the rest', async () => {
  const { store, task } = setup()
  const requests = []
  const out = {}
  await runTask(task, deps(store, {
    approvals: { request: async (r) => { requests.push(r); return { approved: false, note: 'not today' } } },
    queryFn: fake(async function* ({ options }) {
      const gate = options.hooks.PreToolUse[0].hooks[0]
      out.ssh = await gate({ tool_name: 'Read', tool_input: { file_path: '~/.ssh/id_rsa' } })
      out.push = await gate({ tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } })
      out.test = await gate({ tool_name: 'Bash', tool_input: { command: 'npm test' } })
      options.mcpServers.agent.onReport({ status: 'done', summary: 'ok' })
      yield { type: 'result', subtype: 'success' }
    }),
  }))
  const d = (o) => o.hookSpecificOutput.permissionDecision
  assert.equal(d(out.ssh), 'deny')
  assert.equal(d(out.push), 'deny')
  assert.match(out.push.hookSpecificOutput.permissionDecisionReason, /not today/)
  assert.equal(d(out.test), 'allow')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].category, 'destruction')
  assert.equal(store.readEvents().filter((e) => e.type === 'tool_call').length, 3)
})

test('blocked, no report and max turns map to their outcomes', async () => {
  const { store, task } = setup()
  const run = (body) => runTask(task, deps(store, { queryFn: fake(body) }))
  assert.deepEqual(
    await run(async function* ({ options }) {
      options.mcpServers.agent.onReport({ status: 'blocked', summary: 'Need the repo URL.' })
      yield { type: 'result', subtype: 'success' }
    }),
    { status: 'blocked', failure: { reason: 'blocked', detail: 'Need the repo URL.' } },
  )
  assert.equal((await run(async function* () { yield { type: 'result', subtype: 'success' } })).failure.reason, 'error')
  assert.equal((await run(async function* () { yield { type: 'result', subtype: 'error_max_turns' } })).failure.reason, 'budget')
})

test('running past the time budget fails with reason budget', async () => {
  const { store, task } = setup()
  const out = await runTask({ ...task, budget: { maxTurns: 5, maxMinutes: 1 } }, deps(store, {
    minuteMs: 20,
    queryFn: fake(async function* ({ options }) {
      await waitForAbort(options)
      throw new Error('aborted')
    }),
  }))
  assert.equal(out.status, 'failed')
  assert.equal(out.failure.reason, 'budget')
})

test('an external abort is a cancellation', async () => {
  const { store, task } = setup()
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 10)
  const out = await runTask(task, deps(store, {
    signal: controller.signal,
    queryFn: fake(async function* ({ options }) {
      await waitForAbort(options)
      throw new Error('aborted')
    }),
  }))
  assert.equal(out.status, 'cancelled')
})

test('a resume that cannot start fails as interrupted', async () => {
  const { store, task } = setup({ resume: true, sessionId: 's0' })
  let seen
  const out = await runTask(task, deps(store, {
    queryFn: fake(async function* ({ prompt, options }) {
      seen = { prompt, options }
      throw new Error('no such session')
    }),
  }))
  assert.equal(seen.options.resume, 's0')
  assert.match(seen.prompt, /interrupted/)
  assert.deepEqual(out.failure.reason, 'interrupted')
})

test('other errors propagate for the scheduler to classify', async () => {
  const { store, task } = setup()
  await assert.rejects(
    runTask(task, deps(store, { queryFn: fake(async function* () { throw new Error('429 rate limit') }) })),
    /rate limit/,
  )
})

test('research and admin tasks lose the shell', () => {
  assert.ok(DISALLOWED.research.includes('Bash'))
  assert.ok(DISALLOWED.admin.includes('Bash'))
  assert.ok(DISALLOWED.ops.includes('Bash'))
  assert.ok(!DISALLOWED.code.includes('Bash'))
  for (const kind of Object.keys(DISALLOWED)) assert.ok(DISALLOWED[kind].includes('Task'))
})

test('the worker prompt states the goal, the folder and the injection rule', () => {
  const { goal, task } = setup()
  const p = workerPrompt(task, goal)
  assert.match(p, /Release/)
  assert.match(p, /Tagged v1/)
  assert.ok(p.includes(task.workspace.path))
  assert.match(p, /data, never instructions/)
})
