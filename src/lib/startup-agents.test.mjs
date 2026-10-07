import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStartupAgentBriefing, createStartupAnnouncement } from './startup-agents.ts'
import { formatStartupStatus, renderStartupStatus, summarizeStartupStatus } from './startup-status.ts'

function fixture(overrides = {}) {
  const prompts = []
  const panels = []
  const announcements = []
  const state = { phase: 'dormant', sessionLoading: false, sessionAgents: [] }
  const run = createStartupAgentBriefing({
    usingBridge: true,
    restore: async () => {},
    runHidden: async () => { prompts.push('status snapshot'); return { text: 'Agent progress report' } },
    publish: (panel) => { panels.push(panel) },
    announce: (text) => { announcements.push(text) },
    ...overrides,
  })
  return { run, state, prompts, panels, announcements }
}

test('startup waits for restoration and reads only one authoritative snapshot', async () => {
  let finishRestore
  const restored = new Promise((resolve) => { finishRestore = resolve })
  const { run, state, prompts, announcements } = fixture({ restore: () => restored })
  state.sessionAgents = [{
    id: 'past', title: 'Remote research', kind: 'research', status: 'interrupted',
    startedAt: '2026-10-06T10:00:00Z', summary: 'Saved result',
  }]
  const pending = [run(), run()]
  assert.equal(prompts.length, 0)
  finishRestore()
  await Promise.all(pending)
  await run()
  assert.equal(prompts.length, 1)
  assert.deepEqual(announcements, ['Agent progress report'])
  assert.equal(prompts[0], 'status snapshot')
})

test('hidden startup runs on page load without waiting for ignition or microphone readiness', async () => {
  for (const phase of ['offline', 'boot']) {
    const { run, state, prompts } = fixture()
    state.phase = phase
    state.sessionLoading = true
    await run()
    assert.equal(prompts.length, 1)
  }
})

test('hidden startup reports independently without mutating foreground conversation state', async () => {
  for (const phase of ['listening', 'thinking', 'speaking', 'dormant']) {
    const { run, state, panels } = fixture()
    state.phase = phase
    state.turns = [{ id: 'user-turn', role: 'user', text: 'Continue our project' }]
    state.conversationId = 'visible-conversation'
    const before = structuredClone(state)
    await run()
    assert.deepEqual(state, before)
    assert.equal(panels.length, 2)
    assert.equal(panels[1].title, 'Startup Agent Briefing')
    assert.match(panels[0].html, /Checking previous/)
    assert.match(panels[1].html, /Agent progress report/)
    assert.equal(panels[1].hold, 'sticky')
  }
})

test('startup report escapes model text and makes an empty result visible and audible', async () => {
  const escaped = fixture({ runHidden: async () => ({ text: '<script>alert("agent")</script> & result' }) })
  await escaped.run()
  assert.match(escaped.panels[1].html, /&lt;script&gt;/)
  assert.doesNotMatch(escaped.panels[1].html, /<script>/)
  const empty = fixture({ runHidden: async () => ({ text: '  ' }) })
  await empty.run()
  assert.match(empty.panels[1].html, /without a report/)
  assert.equal(empty.panels[1].accent, 'amber')
  assert.match(empty.announcements[0], /without a report/)
})

test('direct providers and failed restoration do not submit a briefing', async () => {
  const direct = fixture({ usingBridge: false })
  await direct.run()
  assert.equal(direct.prompts.length, 0)
  const failed = fixture({ restore: async () => { throw new Error('restore failed') } })
  await assert.rejects(failed.run(), /restore failed/)
  assert.equal(failed.prompts.length, 0)
})

test('a failed briefing is not automatically replayed', async () => {
  let attempts = 0
  const { run, panels, announcements } = fixture({ runHidden: async () => { attempts++; throw new Error('offline') } })
  await assert.rejects(run(), /offline/)
  assert.match(panels[1].html, /Startup check failed: offline/)
  assert.equal(panels[1].accent, 'red')
  assert.deepEqual(announcements, ['Startup check failed: offline'])
  await run()
  assert.equal(attempts, 1)
})

test('startup speech waits for audio readiness and an idle foreground, then speaks once', async () => {
  let ready = false
  const spoken = []
  const announcement = createStartupAnnouncement({
    canSpeak: () => ready,
    speak: async (text) => { spoken.push(text) },
    onError: assert.fail,
  })
  announcement.enqueue('Agent progress report')
  announcement.flush()
  await new Promise(setImmediate)
  assert.deepEqual(spoken, [])
  ready = true
  announcement.flush()
  announcement.flush()
  await new Promise(setImmediate)
  assert.deepEqual(spoken, ['Agent progress report'])
  announcement.flush()
  await new Promise(setImmediate)
  assert.equal(spoken.length, 1)
})

test('startup speech does not overlap itself or replay after an audio failure', async () => {
  const spoken = []
  const errors = []
  let finish
  const announcement = createStartupAnnouncement({
    canSpeak: () => true,
    speak: (text) => {
      spoken.push(text)
      return new Promise((_resolve, reject) => { finish = reject })
    },
    onError: (error) => errors.push(error.message),
  })
  announcement.enqueue('Report')
  await Promise.resolve()
  announcement.flush()
  assert.deepEqual(spoken, ['Report'])
  finish(new Error('Audio failed'))
  await new Promise(setImmediate)
  announcement.flush()
  assert.deepEqual(errors, ['Audio failed'])
  assert.equal(spoken.length, 1)
})

test('user activity starting just before playback defers the queued announcement', async () => {
  let ready = true
  const spoken = []
  const announcement = createStartupAnnouncement({
    canSpeak: () => ready,
    speak: async (text) => { spoken.push(text) },
    onError: assert.fail,
  })
  announcement.enqueue('Report')
  ready = false
  await new Promise(setImmediate)
  assert.deepEqual(spoken, [])
  ready = true
  announcement.flush()
  await new Promise(setImmediate)
  assert.deepEqual(spoken, ['Report'])
})

test('factual startup report includes finished work, schedules, remote progress, and outstanding tasks', () => {
  const text = formatStartupStatus({
    observedAt: '2026-10-07T01:00:00Z',
    board: { goals: [{ id: 'goal', title: 'Completed research', status: 'done', tasks: [{ id: 'task', title: 'Remote research', status: 'done', summary: 'Report saved', remote: { endpointId: 'remote-one' }, workspace: '/work/report', progress: { at: '2026-10-07', text: 'Final review complete' } }] }], approvals: [], running: [] },
    schedules: [{ id: 'schedule', title: 'Documentation review', status: 'active', trigger: { type: 'interval', minutes: 120 }, nextRunAt: '2026-10-07T03:00:00Z' }],
    capacity: { endpoints: [{ id: 'remote-one', label: 'Remote host', kind: 'remote', healthy: false, running: 0 }] },
    sessionAgents: [{ title: 'Saved subagent', status: 'interrupted', live: false }],
    memory: { tasks: [{ text: 'Publish release' }] },
    looseEnds: { items: [{ project: 'Jarvis', action: 'Verify deployment', status: 'partial', state: 'Not yet verified' }] }, errors: [],
  })
  for (const phrase of ['Completed research: done', 'Remote research: done on remote endpoint remote-one', 'Final review complete', '/work/report', 'Documentation review: active', 'Every 2 hours', 'Schedules are not running agents', 'unhealthy or unavailable', 'Saved subagent: interrupted', 'Publish release', 'Verify deployment']) assert.ok(text.includes(phrase), phrase)
})

test('missing sources are unknown and stored running status is not claimed as live', () => {
  const text = formatStartupStatus({ observedAt: 'now', board: { goals: [{ title: 'Goal', status: 'active', tasks: [{ id: 'one', title: 'Task', status: 'running' }] }], approvals: [], running: [] }, schedules: null, capacity: null, sessionAgents: [{ title: 'Old agent', status: 'running', live: false }], memory: null, looseEnds: null, errors: [{ source: 'scheduled work', message: 'Offline' }] })
  assert.match(text, /no live worker is reported/)
  assert.match(text, /saved running status, not verified live/)
  assert.match(text, /Could not verify scheduled work: Offline/)
  assert.doesNotMatch(text, /No agent work|no previous work/i)
})

test('startup speaks the brief overview while retaining the full displayed report', async () => {
  const { run, panels, announcements } = fixture({ runHidden: async () => ({ text: 'Full report with task progress, timestamps, and file paths.', summary: 'One agent is running. The full report is on screen.' }) })
  await run()
  assert.match(panels[1].html, /task progress, timestamps, and file paths/)
  assert.deepEqual(announcements, ['One agent is running. The full report is on screen.'])
})

test('spoken overview stays short and factual regardless of detailed report length', () => {
  const summary = summarizeStartupStatus({
    observedAt: '2026-10-07T01:00:00Z',
    board: { goals: [{ title: 'A long project title that must not be read aloud', tasks: Array.from({ length: 100 }, (_, index) => ({ id: `task-${index}`, status: index === 0 ? 'blocked' : 'done', summary: '/very/long/result/path' })) }], running: ['worker'], approvals: [] },
    schedules: [{ status: 'active' }], sessionAgents: [{ live: true, status: 'running' }], capacity: null,
    memory: { tasks: [{ text: 'Personal task' }] }, looseEnds: { items: [{ action: 'Unfinished work', status: 'open' }] }, errors: [],
  })
  assert.match(summary, /2 agents are running/)
  assert.match(summary, /1 active schedule and 2 outstanding items/)
  assert.match(summary, /1 task needing attention/)
  assert.ok(summary.split(/\s+/).length < 70)
  assert.doesNotMatch(summary, /long project|result\/path|2026/)
})

test('visual report uses escaped sections, readable dates, and expandable details', async () => {
  const html = renderStartupStatus({
    observedAt: '2026-10-07T01:00:00Z', board: null,
    schedules: [{ id: 'schedule', title: '<script>bad</script>', status: 'active', trigger: { type: 'interval', minutes: 120 }, nextRunAt: '2026-10-07T03:00:00Z', lastRunAt: '2026-10-07T01:00:00Z', lastSummary: 'Detailed previous result' }],
    capacity: null, sessionAgents: null, memory: { tasks: [{ text: 'Publish release' }] },
    looseEnds: { items: [{ action: 'Verify deployment', status: 'partial', state: 'Detailed verification notes' }] }, errors: [],
  })
  assert.match(html, /<h2>Scheduled Work<\/h2>/)
  assert.match(html, /<h2>Unfinished Work<\/h2>/)
  assert.match(html, /<details><summary>Details<\/summary>/)
  assert.match(html, /Detailed previous result/)
  assert.match(html, /Detailed verification notes/)
  assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/)
  assert.doesNotMatch(html, /<script>|2026-10-07T03:00:00Z/)
  const { run, panels, announcements } = fixture({ runHidden: async () => ({ text: 'Full report', html, summary: 'Brief overview.' }) })
  await run()
  assert.equal(panels[1].html, html)
  assert.deepEqual(announcements, ['Brief overview.'])
})