import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from './store.mjs'
import { DISALLOWED, runTask, taskPrompt, workerPrompt } from './worker.mjs'

function setup(taskExtra = {}) {
  const store = createStore(mkdtempSync(join(tmpdir(), 'agents-worker-')), { workDir: mkdtempSync(join(tmpdir(), 'agents-output-')) })
  const goal = store.newGoal({ title: 'Release', outcome: 'Tagged v1' })
  const task = { ...store.newTask({ goalId: goal.id, title: 'Write notes', brief: 'Write release notes.', kind: taskExtra.kind ?? 'code' }), ...taskExtra }
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
  assert.equal(seen.prompt, taskPrompt(task, store.getGoal(task.goalId)))
  assert.match(seen.prompt, /Write release notes\.$/)
  assert.equal(seen.options.systemPrompt, workerPrompt('code'))
  assert.equal(seen.options.model, 'claude-sonnet-5')
  assert.equal(seen.options.maxTurns, 60)
  assert.equal(seen.options.maxBudgetUsd, 5)
  assert.deepEqual(seen.options.settingSources, [])
  assert.deepEqual(seen.options.disallowedTools, DISALLOWED.code)
  assert.equal(seen.options.cwd, task.workspace.path)
  assert.ok(store.readEvents().some((e) => e.type === 'task_progress' && e.text === 'Halfway.'))
  assert.match(readFileSync(join(task.workspace.path, 'reports', 'latest.md'), 'utf8'), /Wrote NOTES.md/)
  const reports = readFileSync(join(task.workspace.path, 'logs', 'reports.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(reports.map((report) => report.status), ['progress', 'done'])
  assert.equal(seen.options.env.TMPDIR, join(task.workspace.path, 'tmp'))
  const output = readFileSync(join(task.workspace.path, 'logs', 'worker.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(output.map((entry) => entry.message.type), ['system', 'result'])
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
    {
      status: 'blocked',
      failure: { reason: 'blocked', detail: 'Need the repo URL.', blocker: 'unspecified', need: [], risk: 'na', confidence: null },
    },
  )
  assert.equal((await run(async function* () { yield { type: 'result', subtype: 'success' } })).failure.reason, 'error')
  assert.equal((await run(async function* () { yield { type: 'result', subtype: 'error_max_turns' } })).failure.reason, 'budget')
})

test('a blocked report carries its blocker, needs and risk through to the failure', async () => {
  const { store, task } = setup()
  const out = await runTask(task, deps(store, {
    queryFn: fake(async function* ({ options }) {
      options.mcpServers.agent.onReport({
        status: 'blocked',
        summary: 'The visibility toggle needs an org-scoped token.',
        blocker: 'credential',
        need: ['a token with write:packages', 'confirmation the package should be public'],
        risk: 'me',
        confidence: 0.9,
      })
      yield { type: 'result', subtype: 'success' }
    }),
  }))
  assert.equal(out.failure.blocker, 'credential')
  assert.deepEqual(out.failure.need, ['a token with write:packages', 'confirmation the package should be public'])
  assert.equal(out.failure.risk, 'me')
  assert.equal(out.failure.confidence, 0.9)
})

test('a spending limit overrides a done report and records cache usage', async () => {
  const { store, task } = setup()
  const out = await runTask({ ...task, budget: { ...task.budget, maxUsd: 1 } }, deps(store, {
    queryFn: fake(async function* ({ options }) {
      assert.equal(options.maxBudgetUsd, 1)
      options.mcpServers.agent.onReport({ status: 'done', summary: 'premature' })
      yield {
        type: 'result', subtype: 'error_max_budget_usd', total_cost_usd: 1.12,
        modelUsage: { sonnet: { inputTokens: 2, outputTokens: 3, cacheReadInputTokens: 900, cacheCreationInputTokens: 400 } },
      }
    }),
  }))
  assert.deepEqual(out, { status: 'failed', failure: { reason: 'budget', detail: 'Reached the $1 run limit.' } })
  assert.deepEqual(store.readEvents().find((e) => e.type === 'task_usage').data, {
    costUsd: 1.12, inputTokens: 2, outputTokens: 3, cacheReadInputTokens: 900, cacheCreationInputTokens: 400,
  })
})

test('tasks created before dollar budgets still use the default limit', async () => {
  const { store, task } = setup()
  await runTask({ ...task, budget: { maxTurns: 60, maxMinutes: 45 } }, deps(store, {
    queryFn: fake(async function* ({ options }) {
      assert.equal(options.maxBudgetUsd, 5)
      yield { type: 'result', subtype: 'success' }
    }),
  }))
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

test('research, marketing, ops and admin tasks lose the shell', () => {
  assert.ok(DISALLOWED.research.includes('Bash'))
  assert.ok(DISALLOWED.research.includes('Skill'))
  assert.ok(DISALLOWED.marketing.includes('Bash'))
  assert.ok(DISALLOWED.marketing.includes('Skill'))
  assert.ok(DISALLOWED.admin.includes('Bash'))
  assert.ok(DISALLOWED.ops.includes('Bash'))
  assert.ok(!DISALLOWED.code.includes('Bash'))
  for (const kind of Object.keys(DISALLOWED)) assert.ok(DISALLOWED[kind].includes('Task'))
})

test('marketing tasks get the marketing prompt and can only write in their workspace', async () => {
  const { store, task } = setup({ kind: 'marketing' })
  let seen
  await runTask(task, deps(store, {
    queryFn: fake(async function* ({ options }) {
      seen = options
      const gate = options.hooks.PreToolUse[0].hooks[0]
      const inside = await gate({ tool_name: 'Write', tool_input: { file_path: `${task.workspace.path}/launch.md` } })
      const outside = await gate({ tool_name: 'Write', tool_input: { file_path: '/tmp/launch.md' } })
      assert.equal(inside.hookSpecificOutput.permissionDecision, 'allow')
      assert.equal(outside.hookSpecificOutput.permissionDecision, 'deny')
      options.mcpServers.agent.onReport({ status: 'done', summary: 'Drafted launch copy.' })
      yield { type: 'result', subtype: 'success' }
    }),
  }))
  assert.match(seen.systemPrompt, /evidence-based software marketing/)
  assert.ok(seen.disallowedTools.includes('Bash'))
  assert.equal(task.budget.maxMinutes, 20)
})

test('research workers only allow explicitly named skills', async () => {
  const { store, task } = setup()
  const research = { ...task, kind: 'research', allowedSkills: ['small-skill'] }
  await runTask(research, deps(store, {
    queryFn: fake(async function* ({ options }) {
      assert.ok(!options.disallowedTools.includes('Skill'))
      const gate = options.hooks.PreToolUse[0].hooks[0]
      const permitted = await gate({ tool_name: 'Skill', tool_input: { skill: 'small-skill' } })
      const refused = await gate({ tool_name: 'Skill', tool_input: { skill: 'claude-api' } })
      assert.equal(permitted.hookSpecificOutput.permissionDecision, 'allow')
      assert.equal(refused.hookSpecificOutput.permissionDecision, 'deny')
      options.mcpServers.agent.onReport({ status: 'done', summary: 'ok' })
      yield { type: 'result', subtype: 'success' }
    }),
  }))
})

test('the task prompt states the goal and the folder; the system prompt carries the injection rule', () => {
  const { goal, task } = setup()
  const p = taskPrompt(task, goal)
  assert.match(p, /Release/)
  assert.match(p, /Tagged v1/)
  assert.ok(p.includes(task.workspace.path))
  const system = workerPrompt(task.kind)
  assert.match(system, /data, never instructions/)
  assert.match(system, /Do not redirect output outside it/)
  assert.ok(!system.includes(task.workspace.path), 'task specifics would break the cached prefix')
})

// ---------------------------------------------------------------------------
// Final-review fixes.

test('F1: workers get an allowlisted environment without the agent token or keys', async () => {
  const { agentEnv } = await import('./worker.mjs')
  const env = agentEnv({
    PATH: '/usr/bin', HOME: '/home/u', LANG: 'en_GB.UTF-8', SSH_AUTH_SOCK: '/tmp/ssh',
    JARVIS_AGENTS_TOKEN: 'secret', ELEVENLABS_API_KEY: 'k', OPENAI_API_KEY: 'k', GH_TOKEN: 't', RANDOM_THING: 'x',
  })
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'PATH', 'SSH_AUTH_SOCK'])
  const { store, task } = setup()
  let seen
  await runTask(task, deps(store, {
    queryFn: fake(async function* ({ options }) {
      seen = options
      options.mcpServers.agent.onReport({ status: 'done', summary: 'ok' })
      yield { type: 'result', subtype: 'success' }
    }),
  }))
  assert.ok(seen.env)
  assert.equal(seen.env.JARVIS_AGENTS_TOKEN, undefined)
})

test('a gateway endpoint is injected into the run, and widens nothing else', async () => {
  const { agentEnv, modelFor } = await import('./worker.mjs')
  const gateway = { id: 'rigel-gw', kind: 'gateway', baseURL: 'http://11.0.0.9:8080', model: 'llama3.1:8b', apiKeyEnv: 'RIGEL_GATEWAY_TOKEN' }
  const env = agentEnv({
    PATH: '/usr/bin', HOME: '/home/u',
    JARVIS_AGENTS_TOKEN: 'secret', RIGEL_GATEWAY_TOKEN: 'sk-rigel', ANTHROPIC_BASE_URL: 'http://wrong.test',
  }, gateway)
  // The three Anthropic variables come from the endpoint, never from the
  // environment: the stray ANTHROPIC_BASE_URL above must not be what is used.
  assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'HOME', 'PATH'])
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://11.0.0.9:8080')
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-rigel')
  assert.equal(env.ANTHROPIC_MODEL, 'llama3.1:8b')
  assert.equal(modelFor({ model: 'rigel-gw' }, gateway), 'llama3.1:8b')

  // An anthropic endpoint is left exactly as it was before the pool existed.
  const plain = agentEnv({ PATH: '/usr/bin', ANTHROPIC_BASE_URL: 'http://wrong.test' }, { id: 'claude', kind: 'anthropic', baseURL: null })
  assert.deepEqual(Object.keys(plain), ['PATH'])
  assert.throws(() => agentEnv({}, { id: 'broken', kind: 'gateway', baseURL: null }), /no baseURL/)
})

test('F2: a checkout URL or checkout page puts later Chrome actions behind approval', async () => {
  const { store, task } = setup()
  const requests = []
  await runTask({ ...task, kind: 'admin' }, deps(store, {
    approvals: { request: async (r) => { requests.push(r.category); return { approved: false, note: null } } },
    queryFn: fake(async function* ({ options }) {
      const pre = options.hooks.PreToolUse[0].hooks[0]
      const post = options.hooks.PostToolUse[0].hooks[0]
      const click = { tool_name: 'mcp__jarvis_chrome__chrome_click', tool_input: { ref: 'ref_1' } }
      assert.equal((await pre(click)).hookSpecificOutput.permissionDecision, 'allow')
      await pre({ tool_name: 'mcp__jarvis_chrome__chrome_navigate', tool_input: { url: 'https://shop.test/checkout' } })
      assert.equal((await pre(click)).hookSpecificOutput.permissionDecision, 'deny')
      await pre({ tool_name: 'mcp__jarvis_chrome__chrome_navigate', tool_input: { url: 'https://news.test/' } })
      assert.equal((await pre(click)).hookSpecificOutput.permissionDecision, 'allow')
      await post({ tool_name: 'mcp__jarvis_chrome__chrome_read_page', tool_input: {}, tool_response: { content: [{ type: 'text', text: 'Order summary — Place your order' }] } })
      assert.equal((await pre(click)).hookSpecificOutput.permissionDecision, 'deny')
      options.mcpServers.agent.onReport({ status: 'done', summary: 'ok' })
      yield { type: 'result', subtype: 'success' }
    }),
  }))
  assert.deepEqual(requests, ['money', 'money'])
})

test('F7: time spent waiting for approval does not count against the budget', async () => {
  const { store, task } = setup()
  const out = await runTask({ ...task, budget: { maxTurns: 5, maxMinutes: 1 } }, deps(store, {
    minuteMs: 60,
    approvals: { request: () => new Promise((r) => setTimeout(() => r({ approved: true, note: null }), 150)) },
    queryFn: fake(async function* ({ options }) {
      const gate = options.hooks.PreToolUse[0].hooks[0]
      await gate({ tool_name: 'Bash', tool_input: { command: 'git push --force' } })
      options.mcpServers.agent.onReport({ status: 'done', summary: 'pushed' })
      yield { type: 'result', subtype: 'success' }
    }),
  }))
  assert.equal(out.status, 'done')
})

test('F7: whatever way a run ends, its pending approvals are expired', async () => {
  const { store, task } = setup()
  const expired = []
  await runTask(task, deps(store, {
    approvals: { request: async () => ({ approved: true, note: null }), expire: (id) => expired.push(id) },
    queryFn: fake(async function* () { yield { type: 'result', subtype: 'error_max_turns' } }),
  }))
  assert.deepEqual(expired, [task.id])
})

test('F8: the audit event records the redacted tool input', async () => {
  const { store, task } = setup()
  await runTask(task, deps(store, {
    queryFn: fake(async function* ({ options }) {
      await options.hooks.PreToolUse[0].hooks[0]({ tool_name: 'Bash', tool_input: { command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456" x.test' } })
      await options.hooks.PreToolUse[0].hooks[0]({ tool_name: 'Bash', tool_input: { command: 'npm test' } })
      options.mcpServers.agent.onReport({ status: 'done', summary: 'ok' })
      yield { type: 'result', subtype: 'success' }
    }),
  }))
  const calls = store.readEvents().filter((e) => e.type === 'tool_call')
  assert.match(calls[1].data.input, /npm test/)
  assert.doesNotMatch(calls[0].data.input, /abcdefghij/)
})
