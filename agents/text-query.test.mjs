import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { textProvider } from '../bridge/providers.mjs'
import { createActions, sdkModel } from './coordinator.mjs'
import { createStore } from './store.mjs'
import { scheduleModels, textQuery } from './text-query.mjs'
import { runTask } from './worker.mjs'

const call = (name, args, index = 0) => ({ id: `call-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const env = { OPENAI_API_KEY: 'fixture-key', OPENAI_MODEL: 'gpt-test' }
const execution = { provider: 'openai', model: 'gpt-test' }

async function fixture(handler) {
  const bodies = []
  const server = createServer(async (request, response) => {
    const parts = []
    for await (const part of request) parts.push(part)
    const body = JSON.parse(Buffer.concat(parts).toString())
    bodies.push(body)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message: handler(body, bodies.length) }] }))
  })
  await new Promise((accept) => server.listen(0, '127.0.0.1', accept))
  const selected = []
  const makeTextQuery = (choice, options = {}) => textQuery(choice, {
    ...options, env,
    streamFactory: (provider, _env, model) => {
      selected.push({ provider, model })
      return textProvider({ id: 'fixture', baseURL: `http://127.0.0.1:${server.address().port}/v1`, model }, env)
    },
  })
  return { bodies, selected, makeTextQuery, close: () => new Promise((accept) => server.close(accept)) }
}

test('OpenAI plans and runs with real MCP tools, denies credentials, and reports artifacts without Claude', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scheduled-openai-'))
  const store = createStore(join(root, 'state'), { workDir: join(root, 'work') })
  const goal = store.newGoal({ title: 'Write report', outcome: 'Report saved', execution })
  let denied = false
  const model = await fixture((body) => {
    if (body.tools.some((entry) => entry.function.name === 'mcp__coord__plan_tasks')) {
      return body.messages.length === 2
        ? { role: 'assistant', tool_calls: [call('mcp__coord__plan_tasks', { tasks: [{ key: 'report', title: 'Write report', brief: 'Save report.md.', kind: 'code', model: 'opus' }] })] }
        : { role: 'assistant', content: 'Planned.' }
    }
    const results = body.messages.filter((message) => message.role === 'tool')
    if (!results.length) return { role: 'assistant', tool_calls: [call('Read', { file_path: '/home/dockerbox/.ssh/id_rsa' })] }
    if (results.length === 1) {
      denied = results[0].content.startsWith('Blocked:')
      return { role: 'assistant', tool_calls: [call('Write', { file_path: 'report.md', content: 'Verified fixture report.' })] }
    }
    return { role: 'assistant', tool_calls: [call('mcp__agent__report', { status: 'done', summary: 'Report saved.', artifacts: ['report.md'] })] }
  })
  try {
    await sdkModel({ env, makeTextQuery: model.makeTextQuery, queryFn: () => { throw new Error('Claude must not run') } })({
      prompt: 'Plan this report.', actions: createActions(store, goal.id), execution,
    })
    const [task] = store.listTasks()
    assert.deepEqual(task.execution, execution)
    assert.equal(task.model, execution.model)
    const result = await runTask(task, {
      store, contacts: () => new Set(), approvals: { request: async () => { throw new Error('Credential access must be denied, not approved') } },
      prepare: () => { mkdirSync(task.workspace.path, { recursive: true }); return task.workspace.path },
      makeTextQuery: model.makeTextQuery, queryFn: () => { throw new Error('Claude must not run') },
    })
    assert.equal(result.status, 'done')
    assert.deepEqual(result.result.artifacts, ['report.md'])
    assert.equal(readFileSync(join(task.workspace.path, 'report.md'), 'utf8'), 'Verified fixture report.')
    assert.ok(denied)
    assert.deepEqual(model.selected, [execution, execution])
    assert.ok(store.readEvents().some((event) => event.type === 'tool_call' && event.data.decision === 'deny'))
  } finally { await model.close() }
})

test('text research workers deny outside writes, omit Bash, and stop after completion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scheduled-policy-'))
  const store = createStore(join(root, 'state'), { workDir: join(root, 'work') })
  const goal = store.newGoal({ title: 'Report', outcome: 'Done', execution })
  const task = store.newTask({ goalId: goal.id, title: 'Check', brief: 'Write report', kind: 'research' })
  const outside = join(root, 'outside.md')
  let approvals = 0
  const model = await fixture((body, round) => {
    assert.ok(!body.tools.some((entry) => entry.function.name === 'Bash'))
    if (round === 1) return { role: 'assistant', tool_calls: [call('Write', { file_path: outside, content: 'Not permitted' })] }
    assert.match(body.messages.at(-1).content, /Blocked:/)
    return { role: 'assistant', tool_calls: [
      call('mcp__agent__report', { status: 'done', summary: 'Stopped safely.' }),
      call('Write', { file_path: 'too-late.md', content: 'Must not execute' }, 1),
    ] }
  })
  try {
    const result = await runTask(task, {
      store, contacts: () => new Set(), approvals: { request: async () => { approvals++; return { approved: false } } },
      prepare: () => { mkdirSync(task.workspace.path, { recursive: true }); return task.workspace.path },
      makeTextQuery: model.makeTextQuery,
    })
    assert.equal(result.status, 'done')
    assert.equal(approvals, 0)
    assert.equal(existsSync(outside), false)
    assert.equal(existsSync(join(task.workspace.path, 'too-late.md')), false)
    assert.equal(model.bodies.length, 2)
  } finally { await model.close() }
})

test('text code workers wait for approval and honor a refusal before executing tools', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scheduled-approval-'))
  const store = createStore(join(root, 'state'), { workDir: join(root, 'work') })
  const goal = store.newGoal({ title: 'Report', outcome: 'Done', execution })
  const task = store.newTask({ goalId: goal.id, title: 'Check', brief: 'Write report', kind: 'code' })
  const outside = join(root, 'outside.md')
  writeFileSync(outside, 'Original')
  let approvals = 0
  const model = await fixture((body, round) => {
    if (round === 1) return { role: 'assistant', tool_calls: [call('Write', { file_path: outside, content: 'Not permitted' })] }
    assert.match(body.messages.at(-1).content, /Blocked:.*denied/)
    return { role: 'assistant', tool_calls: [call('mcp__agent__report', { status: 'blocked', summary: 'Approval denied.', blocker: 'approval', need: ['Permission to overwrite the file'] })] }
  })
  try {
    const result = await runTask(task, {
      store, contacts: () => new Set(), approvals: { request: async () => { approvals++; return { approved: false } } },
      prepare: () => { mkdirSync(task.workspace.path, { recursive: true }); return task.workspace.path },
      makeTextQuery: model.makeTextQuery,
    })
    assert.equal(result.status, 'blocked')
    assert.equal(result.failure.blocker, 'approval')
    assert.equal(approvals, 1)
    assert.equal(readFileSync(outside, 'utf8'), 'Original')
  } finally { await model.close() }
})

test('unavailable providers and models fail explicitly without provider fallback', async () => {
  for (const choice of [execution, { provider: 'local', model: 'missing' }]) {
    const run = textQuery(choice, { env: {}, streamFactory: () => { throw new Error('No provider should be invoked') } })
    await assert.rejects(async () => { for await (const _result of run({ prompt: 'Plan', options: {} })) {} }, /unavailable/)
  }
  assert.deepEqual(scheduleModels({ JARVIS_ENDPOINTS: JSON.stringify([
    { id: 'gateway', kind: 'gateway', model: 'not-openai', baseURL: 'http://localhost:4000' },
    { id: 'local', kind: 'openai', model: 'qwen', baseURL: 'http://localhost:11434/v1' },
  ]) }).local, ['qwen'])
})

test('models that return prose instead of required tool calls fail explicitly', async () => {
  const model = await fixture(() => ({ role: 'assistant', content: 'I have planned the tasks.' }))
  try {
    const root = mkdtempSync(join(tmpdir(), 'scheduled-no-tools-'))
    const store = createStore(root)
    const goal = store.newGoal({ title: 'Report', outcome: 'Saved', execution })
    await assert.rejects(sdkModel({ env, makeTextQuery: model.makeTextQuery })({
      prompt: 'Plan', execution, actions: createActions(store, goal.id),
    }), /required tools/)
    assert.equal(store.listTasks().length, 0)
  } finally { await model.close() }
})

test('cancellation during the permission gate prevents the actual tool call', async () => {
  const controller = new AbortController()
  let called = false
  let closed = false
  const query = textQuery(execution, {
    env,
    makeBroker: async () => ({
      tools: () => [{ type: 'function', function: { name: 'mcp__coord__note' } }],
      call: async () => { called = true; return 'Noted.' },
      close: async () => { closed = true },
    }),
    streamFactory: () => async (_messages, _signal, _onText, options) => options.callTool('mcp__coord__note', { text: 'Stop' }),
  })
  await assert.rejects(async () => {
    for await (const _result of query({ prompt: 'Plan', options: {
      systemPrompt: 'Plan safely.', abortController: controller,
      hooks: { PreToolUse: [{ hooks: [async () => {
        controller.abort()
        return { hookSpecificOutput: { permissionDecision: 'allow' } }
      }] }] },
    } })) {}
  }, /abort/i)
  assert.equal(called, false)
  assert.equal(closed, true)
})