import test from 'node:test'
import assert from 'node:assert/strict'

import { SESSION_AGENT_TOOL, createSessionAgents } from './session-agents.mjs'

/** A tracker whose frames land synchronously, so tests need no timers. */
const tracker = (options = {}) => {
  const frames = []
  const agents = createSessionAgents({ send: (f) => frames.push(f), delay: 0, ...options })
  return { agents, frames, settled: () => new Promise((r) => setTimeout(r, 1)) }
}

test('the tool it watches is the Task tool', () => {
  assert.equal(SESSION_AGENT_TOOL, 'Task')
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

test('finished subagents are forgotten past the limit, running ones never', async () => {
  const { agents, settled } = tracker({ limit: 2 })
  agents.start('old', {})
  agents.settle('old', false, 'first')
  agents.start('live', {})
  agents.start('new', {})
  await settled()
  assert.deepEqual(agents.list().map((a) => a.id), ['live', 'new'])
})

test('a running subagent survives even when it is over the limit', async () => {
  const { agents, settled } = tracker({ limit: 1 })
  agents.start('a', {})
  agents.start('b', {})
  await settled()
  assert.deepEqual(agents.list().map((a) => a.id), ['a', 'b'])
})

test('stopping the tracker drops a frame that has not gone out yet', async () => {
  const { agents, frames } = tracker({ delay: 5 })
  agents.start('t1', {})
  agents.stop()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(frames.length, 0)
})
