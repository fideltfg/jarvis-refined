import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  SESSION_AGENT_TOOLS,
  isSessionAgentTool,
  createSessionAgents,
  loadSessionAgents,
  parseTaskNotification,
} from './session-agents.mjs'

/**
 * A tracker whose frames land synchronously, so tests need no timers.
 *
 * `file: null` by default on purpose: the tracker persists to a real path under
 * the home directory, and a test that inherits it reads the machine's actual
 * history and writes its fixtures into it. Persistence is exercised below with
 * a temporary file instead.
 */
const tracker = (options = {}) => {
  const frames = []
  const agents = createSessionAgents({ send: (f) => frames.push(f), delay: 0, file: null, ...options })
  return { agents, frames, settled: () => new Promise((r) => setTimeout(r, 1)) }
}

/** A throwaway history file, removed when the test that made it ends. */
const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-agents-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'session-agents.json')
}

test('it watches the subagent tool under both of its build names', () => {
  assert.deepEqual(SESSION_AGENT_TOOLS, ['Task', 'Agent'])
  assert.equal(isSessionAgentTool('Task'), true)
  assert.equal(isSessionAgentTool('Agent'), true)
  assert.equal(isSessionAgentTool('Bash'), false)
  assert.equal(isSessionAgentTool(undefined), false)
})

test('a started subagent is reported as running, with its description and type', async () => {
  const { agents, frames, settled } = tracker()
  agents.start('t1', { description: 'Audit the CSS', subagent_type: 'Explore' })
  await settled()
  assert.equal(frames.length, 1)
  assert.equal(frames[0].type, 'session_agents')
  assert.equal(frames[0].agents.length, 1)
  assert.partialDeepStrictEqual(frames[0].agents[0], {
    id: 't1',
    title: 'Audit the CSS',
    kind: 'Explore',
    status: 'running',
    summary: null,
  })
  assert.ok(frames[0].agents[0].startedAt)
})

test('a subagent records its provider and model, and dies with its own connection only', async () => {
  const { agents, frames, settled } = tracker()
  const first = Symbol('first')
  const second = Symbol('second')
  agents.start('a', { description: 'One', prompt: 'Read the parser.', run_in_background: true }, { model: 'claude-opus-5', carrier: first })
  agents.start('b', { description: 'Two', model: 'haiku' }, { model: 'claude-opus-5', carrier: second })
  agents.release(first)
  await settled()
  const by = Object.fromEntries(frames.at(-1).agents.map((agent) => [agent.id, agent]))
  assert.partialDeepStrictEqual(by.a, { provider: 'claude', model: 'claude-opus-5', brief: 'Read the parser.', background: true, status: 'interrupted' })
  assert.partialDeepStrictEqual(by.b, { provider: 'claude', model: 'haiku', status: 'running' })
})

test('a subagent with no usable input still gets a title and a kind', async () => {
  const { agents, frames, settled } = tracker()
  agents.start('t1', { description: '   ', subagent_type: null })
  await settled()
  assert.partialDeepStrictEqual(frames[0].agents[0], { title: 'subagent', kind: 'general-purpose' })
})

test('an id already tracked, or no id at all, changes nothing', async () => {
  const { agents, frames, settled } = tracker()
  agents.start('t1', { description: 'First' })
  agents.start('t1', { description: 'Second' })
  agents.start('', { description: 'Nameless' })
  await settled()
  assert.equal(frames.at(-1).agents.length, 1)
  assert.equal(frames.at(-1).agents[0].title, 'First')
})

test('a fan-out of four subagents is one frame, not four', async () => {
  const { agents, frames, settled } = tracker({ delay: 5 })
  for (const id of ['a', 'b', 'c', 'd']) agents.start(id, { description: id })
  await new Promise((r) => setTimeout(r, 20))
  await settled()
  assert.equal(frames.length, 1)
  assert.equal(frames[0].agents.length, 4)
})

test('a finished subagent carries its result as a one-line summary', async () => {
  const { agents, frames, settled } = tracker()
  agents.start('t1', { description: 'Audit' })
  await settled()
  agents.settle('t1', false, [{ type: 'text', text: '  Found\n\ntwo   problems.  ' }])
  await settled()
  const agent = frames.at(-1).agents[0]
  assert.equal(agent.status, 'done')
  assert.equal(agent.summary, 'Found two problems.')
  assert.ok(agent.finishedAt)
})

test('a result that is a plain string is summarised too, and a long one is cut', async () => {
  const { agents, frames, settled } = tracker()
  agents.start('t1', {})
  agents.settle('t1', false, 'x'.repeat(400))
  await settled()
  assert.equal(frames.at(-1).agents[0].summary.length, 160)
})

test('a result with nothing readable leaves the summary empty', async () => {
  const { agents, frames, settled } = tracker()
  agents.start('t1', {})
  agents.settle('t1', false, [{ type: 'image', source: {} }])
  await settled()
  assert.equal(frames.at(-1).agents[0].summary, null)
})

test('a failed subagent is reported as failed', async () => {
  const { agents, frames, settled } = tracker()
  agents.start('t1', {})
  agents.settle('t1', true, 'Permission denied')
  await settled()
  assert.equal(frames.at(-1).agents[0].status, 'failed')
})

test('settling an id that was never started reports nothing', async () => {
  const { agents, frames, settled } = tracker()
  agents.settle('nope', false, 'done')
  await settled()
  assert.equal(frames.length, 0)
})

/**
 * The limit is what the board is shown, not what is remembered. History now
 * outlives the session and lives in a file; a screen that tried to display all
 * of it would push today's work off the bottom.
 */
test('the frame carries only the most recent finished subagents', async () => {
  const { agents, frames, settled } = tracker({ limit: 2 })
  for (const id of ['a', 'b', 'c']) {
    agents.start(id, {})
    agents.settle(id, false, id)
  }
  await settled()
  assert.deepEqual(frames.at(-1).agents.map((a) => a.id), ['b', 'c'])
  // Dropped from the frame, still remembered.
  assert.deepEqual(agents.list().map((a) => a.id), ['a', 'b', 'c'])
})

test('every running subagent is on the frame however far over the limit it is', async () => {
  const { agents, frames, settled } = tracker({ limit: 1 })
  agents.start('done', {})
  agents.settle('done', false, 'x')
  for (const id of ['a', 'b', 'c']) agents.start(id, {})
  await settled()
  assert.deepEqual(frames.at(-1).agents.map((a) => a.id), ['done', 'a', 'b', 'c'])
})

test('a long session forgets finished subagents rather than growing without bound', async () => {
  const { agents, settled } = tracker()
  agents.start('live', {})
  for (let i = 0; i < 60; i += 1) {
    agents.start(`t${i}`, {})
    agents.settle(`t${i}`, false, 'x')
  }
  await settled()
  const ids = agents.list().map((a) => a.id)
  assert.ok(ids.length <= 40, `kept ${ids.length}`)
  // The live one is never a candidate for eviction, however old it gets.
  assert.ok(ids.includes('live'))
  assert.ok(ids.includes('t59'))
})

test('stopping the tracker drops a frame that has not gone out yet', async () => {
  const { agents, frames } = tracker({ delay: 5 })
  agents.start('t1', {})
  agents.stop()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(frames.length, 0)
})

test('the history is written to disk and read back by the next session', async (t) => {
  const file = scratch(t)
  const first = tracker({ file })
  first.agents.start('t1', { description: 'Audit the CSS', subagent_type: 'Explore' })
  first.agents.settle('t1', false, 'Two problems.')
  await first.settled()
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).agents.length, 1)

  const second = tracker({ file })
  assert.partialDeepStrictEqual(second.agents.list()[0], {
    id: 't1',
    title: 'Audit the CSS',
    status: 'done',
    summary: 'Two problems.',
  })
})

test('a subagent still marked running cannot have survived the process that owned it', async (t) => {
  const file = scratch(t)
  const first = tracker({ file })
  first.agents.start('t1', { description: 'Long one' })
  await first.settled()

  const { agents } = tracker({ file })
  assert.partialDeepStrictEqual(agents.list()[0], { id: 't1', status: 'interrupted', finishedAt: null })
})

test('a corrupt or missing history is not worth failing a session over', (t) => {
  const file = scratch(t)
  assert.deepEqual(loadSessionAgents(file), [])
  writeFileSync(file, '{ not json')
  assert.deepEqual(loadSessionAgents(file), [])
  writeFileSync(file, '{"agents":"nope"}')
  assert.deepEqual(loadSessionAgents(file), [])
  assert.deepEqual(loadSessionAgents(null), [])
})

test('history older than a fortnight is not read back', (t) => {
  const file = scratch(t)
  const now = '2026-09-29T12:00:00.000Z'
  const old = '2026-09-01T12:00:00.000Z'
  writeFileSync(
    file,
    JSON.stringify({
      agents: [
        { id: 'ancient', title: 'Old', kind: 'x', status: 'done', startedAt: old, finishedAt: old, summary: null },
        { id: 'recent', title: 'New', kind: 'x', status: 'done', startedAt: now, finishedAt: now, summary: null },
        { id: 'junk', status: 'done' },
      ],
    }),
  )
  assert.deepEqual(
    loadSessionAgents(file, () => now).map((a) => a.id),
    ['recent'],
  )
})

test('a tracker with no file keeps its history to itself', async (t) => {
  const file = scratch(t)
  const { agents, settled } = tracker({ file: null })
  agents.start('t1', {})
  await settled()
  assert.deepEqual(loadSessionAgents(file), [])
})

/**
 * Background dispatch. The Agent tool returns the instant the agent is
 * launched, so the acknowledgement must not be mistaken for a result — the
 * board showed a twenty-minute research run as `done` four seconds in.
 */
const LAUNCH = 'Async agent launched successfully. agentId: af2cf65773a3ecd19 (internal ID - do not mention)'

test('a background dispatch stays running, and never leaks the internal id', async () => {
  const { agents, frames, settled } = tracker()
  agents.start('t1', { description: 'Research passive income routes', subagent_type: 'general-purpose' })
  agents.settle('t1', false, LAUNCH)
  await settled()
  const row = frames.at(-1).agents[0]
  assert.equal(row.status, 'running')
  assert.equal(row.finishedAt, undefined)
  assert.ok(!row.summary.includes('af2cf65773a3ecd19'))
  assert.match(row.summary, /background/)
})

test('a foreground result still settles the row as it always did', async () => {
  const { agents, frames, settled } = tracker()
  agents.start('t1', { description: 'Audit the CSS' })
  agents.settle('t1', false, 'Found three misaligned headers.')
  await settled()
  assert.partialDeepStrictEqual(frames.at(-1).agents[0], { status: 'done', summary: 'Found three misaligned headers.' })
})

test('a completion notification ends the background agent it names', async () => {
  const { agents, frames, settled } = tracker()
  agents.start('t1', { description: 'Research passive income routes' })
  agents.settle('t1', false, LAUNCH)
  agents.notify('af2cf65773a3ecd19', 'completed', 'Report written to disk.')
  await settled()
  const row = frames.at(-1).agents[0]
  assert.equal(row.status, 'done')
  assert.equal(row.summary, 'Report written to disk.')
  assert.ok(row.finishedAt)
})

test('a stopped notification is not a success', async () => {
  const { agents, frames, settled } = tracker()
  agents.start('t1', { description: 'Research' })
  agents.settle('t1', false, LAUNCH)
  agents.notify('af2cf65773a3ecd19', 'stopped', 'No completion record was found.')
  await settled()
  assert.equal(frames.at(-1).agents[0].status, 'interrupted')
})

test('a notification for an agent nobody tracked changes nothing', async () => {
  const { agents, frames, settled } = tracker()
  agents.start('t1', { description: 'Research' })
  await settled()
  const before = frames.length
  agents.notify('someone-else', 'completed', 'done')
  await settled()
  assert.equal(frames.length, before)
})

test('resuming a stopped agent puts the same row back to running', async () => {
  const { agents, frames, settled } = tracker()
  agents.start('t1', { description: 'Research' })
  agents.settle('t1', false, LAUNCH)
  agents.notify('af2cf65773a3ecd19', 'stopped', 'Interrupted.')
  agents.resume('af2cf65773a3ecd19')
  await settled()
  assert.equal(frames.at(-1).agents.length, 1)
  assert.partialDeepStrictEqual(frames.at(-1).agents[0], { status: 'running', finishedAt: null })
})

test('resuming an agent that is already running is not a change', async () => {
  const { agents, frames, settled } = tracker()
  agents.start('t1', { description: 'Research' })
  agents.settle('t1', false, LAUNCH)
  await settled()
  const before = frames.length
  agents.resume('af2cf65773a3ecd19')
  await settled()
  assert.equal(frames.length, before)
})

test('resend reports the current list without anything having changed', async () => {
  const { agents, frames, settled } = tracker()
  agents.start('t1', { description: 'Research' })
  await settled()
  frames.length = 0
  agents.resend()
  await settled()
  assert.equal(frames.length, 1)
  assert.equal(frames[0].agents.length, 1)
})

test('it reads a task notification out of the text it arrives in', () => {
  const note = parseTaskNotification(
    '[SYSTEM NOTIFICATION]\n<task-notification>\n<task-id>af2cf65773a3ecd19</task-id>\n<status>stopped</status>\n<summary>No completion record was found.</summary>\n</task-notification>',
  )
  assert.deepEqual(note, {
    agentId: 'af2cf65773a3ecd19',
    status: 'stopped',
    summary: 'No completion record was found.',
  })
  assert.equal(parseTaskNotification('ordinary prose'), null)
  assert.equal(parseTaskNotification(undefined), null)
  assert.equal(parseTaskNotification('<task-notification></task-notification>'), null)
})
