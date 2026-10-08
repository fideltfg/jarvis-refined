import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import https from 'node:https'

import { createStore } from './store.mjs'
import { createApprovals } from './approvals.mjs'
import { createApi } from './api.mjs'
import { boardOf, briefing } from './briefing.mjs'
import { createPool } from './pool.mjs'
import { parseEndpoints } from '../bridge/endpoints.mjs'
import { createScheduledJobs } from './scheduled-jobs.mjs'

const TOKEN = 'test-token'

/**
 * A throwaway certificate, so the TLS door can be opened for real in a test
 * rather than mocked. Node can mint one itself; openssl is not required.
 */
async function selfSigned() {
  const { execFileSync } = await import('node:child_process')
  const dir = mkdtempSync(join(tmpdir(), 'agents-tls-'))
  const keyPath = join(dir, 'key.pem')
  const certPath = join(dir, 'cert.pem')
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '1',
    '-subj', '/CN=localhost',
  ], { stdio: 'ignore' })
  return { cert: readFileSync(certPath), key: readFileSync(keyPath) }
}

async function setup({ pool = null, host = '127.0.0.1', tls = null, workDir = '/work', skills = [] } = {}) {
  const store = createStore(mkdtempSync(join(tmpdir(), 'agents-api-')), { workDir })
  const approvals = createApprovals(store)
  const calls = { plan: [], redirect: [], cancel: [], mirror: [] }
  // What this machine has installed, in a mutable box, so a test can uninstall
  // a skill between two requests the way a user would between two edits.
  const installed = { list: skills.map((id) => ({ id, name: id, description: `The ${id} skill.`, dir: `/skills/${id}`, file: `/skills/${id}/SKILL.md` })) }
  // What the scheduler claims to be running, so a test can make a task look
  // live without starting one.
  const running = new Set()
  const schedules = createScheduledJobs({ store, coordinator: { plan: async (id) => { calls.plan.push(id) } } })
  const api = createApi({
    store,
    approvals,
    pool,
    token: TOKEN,
    scheduler: { schedules, running: () => running, cancel: (id) => { calls.cancel.push(id); return true } },
    coordinator: {
      plan: async (id) => { calls.plan.push(id) },
      redirect: async (id, text) => { calls.redirect.push([id, text]) },
    },
    cleanup: () => ['t_1'],
    mirror: { goalCreated: (g) => calls.mirror.push(g.id) },
    installedSkills: () => installed.list,
    host,
    tls,
  })
  const port = await api.listen()
  const base = `${tls ? 'https' : 'http'}://127.0.0.1:${port}`
  /**
   * Over TLS this goes through node:https with the test certificate named as
   * the trust root — a real handshake that a wrong certificate would fail,
   * rather than verification switched off.
   */
  const callTls = (method, path, body, token) =>
    new Promise((resolve, reject) => {
      const req = https.request(
        `${base}${path}`,
        {
          method,
          ca: tls.cert,
          servername: 'localhost',
          checkServerIdentity: () => undefined,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        },
        (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString()
            resolve({ status: res.statusCode, json: async () => JSON.parse(text), text: async () => text })
          })
        },
      )
      req.on('error', reject)
      if (body) req.write(JSON.stringify(body))
      req.end()
    })
  const call = (method, path, body, token = TOKEN) =>
    tls
      ? callTls(method, path, body, token)
      : fetch(`${base}${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        })
  return { store, approvals, api, base, call, calls, schedules, running, installed }
}

test('the API refuses to start without a token', () => {
  assert.throws(() => createApi({ token: '' }), /JARVIS_AGENTS_TOKEN/)
})

test('saved reports require authentication and use only the selected task workspace', async () => {
  const instance = await setup()
  const workspace = mkdtempSync(join(tmpdir(), 'agents-api-reports-'))
  try {
    const goal = instance.store.newGoal({ title: 'Reports', outcome: 'Recall' })
    const task = instance.store.newTask({ goalId: goal.id, title: 'Research', brief: 'Read only' })
    instance.store.saveTask({ ...task, status: 'done', archived: true, workspace: { path: workspace }, result: { summary: 'Finished', references: [{ title: 'Latest report', path: 'artifacts/linked.md' }] } })
    mkdirSync(join(workspace, 'reports'))
    mkdirSync(join(workspace, 'artifacts'))
    writeFileSync(join(workspace, 'reports', 'latest.md'), '# Finished')
    writeFileSync(join(workspace, 'artifacts', 'linked.md'), '# Linked')
    const path = `/tasks/${task.id}/reports`
    assert.equal((await instance.call('GET', path, null, 'wrong')).status, 401)
    assert.deepEqual(await (await instance.call('GET', path)).json(), { result: { summary: 'Finished', references: [{ title: 'Latest report', path: 'artifacts/linked.md' }] }, failure: null, files: ['reports/latest.md', 'artifacts/linked.md'] })
    assert.deepEqual(await (await instance.call('GET', `${path}?file=reports/latest.md`)).json(), { file: 'reports/latest.md', content: '# Finished' })
    assert.deepEqual(await (await instance.call('GET', `/tasks/${task.id}/reference?index=0`)).json(), { file: 'Latest report', content: '# Linked' })
    assert.equal((await instance.call('GET', `/tasks/${task.id}/reference?index=200`)).status, 400)
    assert.equal((await instance.call('GET', `${path}?file=${encodeURIComponent('/etc/passwd')}`)).status, 400)
    assert.equal((await instance.call('GET', '/tasks/t_missing/reports')).status, 404)
    assert.equal(instance.calls.plan.length, 0)
    assert.equal(instance.calls.redirect.length, 0)
  } finally { await instance.api.close(); rmSync(workspace, { recursive: true, force: true }) }
})

test('public goal creation cannot supply internal occurrence identity', async () => {
  const instance = await setup()
  try {
    const existing = instance.store.newGoal({ title: 'Existing', outcome: 'Keep' })
    const response = await instance.call('POST', '/goals', { title: 'Other', outcome: 'Check', id: existing.id, scheduleId: 's_fake', occurrenceKey: 'fake' })
    assert.equal(response.status, 201)
    const created = await response.json()
    assert.notEqual(created.id, existing.id)
    assert.equal(created.scheduleId, undefined)
    assert.equal(instance.store.getGoal(existing.id).title, 'Existing')
  } finally { await instance.api.close() }
})

test('schedule API persists without early work, validates changes and runs explicitly', async () => {
  const instance = await setup()
  try {
    assert.equal((await instance.call('POST', '/schedules', { title: 'bad' })).status, 400)
    assert.equal((await instance.call('GET', '/schedules', null, 'wrong')).status, 401)
    const response = await instance.call('POST', '/schedules', { title: 'Report', outcome: 'Check health', trigger: { type: 'interval', minutes: 30 } })
    assert.equal(response.status, 201)
    const schedule = await response.json()
    assert.equal(instance.calls.plan.length, 0)
    assert.equal(instance.store.listGoals().length, 0)
    assert.equal((await (await instance.call('GET', '/board')).json()).schedules.length, 1)
    assert.equal((await instance.call('POST', `/schedules/${schedule.id}`, { action: 'edit', values: { title: 'Updated' } })).status, 200)
    assert.equal((await instance.call('POST', `/schedules/${schedule.id}/run`)).status, 200)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(instance.calls.plan.length, 1)
    assert.equal((await instance.call('POST', `/schedules/${schedule.id}/run`)).status, 400)
    assert.equal((await instance.call('POST', `/schedules/${schedule.id}`, { action: 'delete' })).status, 200)
    assert.deepEqual(await (await instance.call('GET', '/schedules')).json(), [])
    assert.equal((await instance.call('POST', '/schedules/missing', { action: 'pause' })).status, 404)
  } finally { await instance.api.close() }
})

test('profiles create, edit, run from a snapshot and delete their schedule', async () => {
  const instance = await setup()
  try {
    assert.equal((await instance.call('POST', '/profiles', { name: 'Research', role: 'Analyst' })).status, 400)
    const created = await instance.call('POST', '/profiles', { name: ' Research ', role: ' Analyst ', instructions: ' Find primary sources. ' })
    assert.equal(created.status, 201)
    const profile = await created.json()
    assert.equal(profile.name, 'Research')
    assert.equal((await (await instance.call('GET', '/profiles')).json())[0].id, profile.id)
    const run = await instance.call('POST', `/profiles/${profile.id}/run`)
    assert.equal(run.status, 201)
    const goal = await run.json()
    assert.equal(goal.profileSnapshot.instructions, 'Find primary sources.')
    await instance.call('POST', `/profiles/${profile.id}`, { name: 'Updated research', instructions: 'Use official sources.' })
    assert.equal(instance.store.getGoal(goal.id).profileSnapshot.instructions, 'Find primary sources.')
    assert.equal((await instance.call('POST', `/profiles/${profile.id}`, { action: 'delete' })).status, 200)
    assert.deepEqual(await (await instance.call('GET', '/profiles')).json(), [])
    assert.equal((await instance.call('POST', `/profiles/${profile.id}/run`)).status, 404)
  } finally { await instance.api.close() }
})

test('the installed skills a profile may choose from are offered by name and description, without saying where they live', async () => {
  const instance = await setup({ skills: ['loose-ends', 'llm-wiki'] })
  try {
    const listed = await instance.call('GET', '/skills')
    assert.equal(listed.status, 200)
    const skills = await listed.json()
    assert.deepEqual(skills.map((skill) => skill.id), ['loose-ends', 'llm-wiki'])
    assert.equal(skills[0].name, 'loose-ends')
    assert.equal(skills[0].description, 'The loose-ends skill.')
    // The directory each skill came from is this machine's business, not the browser's.
    assert.deepEqual(Object.keys(skills[0]).sort(), ['description', 'id', 'name'])
  } finally { await instance.api.close() }
})

test('a profile saves the skills it selected, by name, and drops them again when deselected', async () => {
  const instance = await setup({ skills: ['loose-ends', 'llm-wiki'] })
  try {
    const created = await instance.call('POST', '/profiles', {
      name: 'Briefer', role: 'Analyst', instructions: 'Check.', skills: ['llm-wiki', 'loose-ends'],
    })
    assert.equal(created.status, 201)
    const profile = await created.json()
    assert.deepEqual(profile.skills, ['llm-wiki', 'loose-ends'])
    assert.deepEqual(instance.store.getProfile(profile.id).skills, ['llm-wiki', 'loose-ends'])
    // An edit that never mentions skills leaves the selection alone.
    const renamed = await instance.call('POST', `/profiles/${profile.id}`, { name: 'Renamed' })
    assert.deepEqual((await renamed.json()).skills, ['llm-wiki', 'loose-ends'])
    const narrowed = await instance.call('POST', `/profiles/${profile.id}`, { skills: ['loose-ends'] })
    assert.deepEqual((await narrowed.json()).skills, ['loose-ends'])
    const cleared = await instance.call('POST', `/profiles/${profile.id}`, { skills: [] })
    assert.deepEqual((await cleared.json()).skills, [])
  } finally { await instance.api.close() }
})

test('a skill nobody has installed is refused at save time, and the refusal says which name is wrong', async () => {
  const instance = await setup({ skills: ['loose-ends'] })
  try {
    const bad = await instance.call('POST', '/profiles', { name: 'Briefer', role: 'Analyst', instructions: 'Check.', skills: ['invented'] })
    assert.equal(bad.status, 400)
    assert.match((await bad.json()).error, /No installed skill named invented/)
    assert.deepEqual(await (await instance.call('GET', '/profiles')).json(), [])
    // A path is not a name, and is refused by the schema before it reaches the disk.
    const pathed = await instance.call('POST', '/profiles', {
      name: 'Briefer', role: 'Analyst', instructions: 'Check.', skills: ['/home/me/.claude/skills/loose-ends'],
    })
    assert.equal(pathed.status, 400)
    const good = await instance.call('POST', '/profiles', { name: 'Briefer', role: 'Analyst', instructions: 'Check.', skills: ['loose-ends'] })
    const profile = await good.json()
    const added = await instance.call('POST', `/profiles/${profile.id}`, { skills: ['loose-ends', 'invented'] })
    assert.equal(added.status, 400)
    assert.match((await added.json()).error, /No installed skill named invented/)
    assert.deepEqual(instance.store.getProfile(profile.id).skills, ['loose-ends'])
  } finally { await instance.api.close() }
})

test('a saved skill that later leaves the disk keeps loading and stays editable, and is not quietly dropped', async () => {
  const instance = await setup({ skills: ['loose-ends', 'llm-wiki'] })
  try {
    const profile = await (await instance.call('POST', '/profiles', {
      name: 'Briefer', role: 'Analyst', instructions: 'Check.', skills: ['loose-ends', 'llm-wiki'],
    })).json()
    // The user uninstalls one of them from ~/.claude/skills.
    instance.installed.list = instance.installed.list.filter((skill) => skill.id !== 'llm-wiki')
    const listed = await instance.call('GET', '/profiles')
    assert.equal(listed.status, 200)
    assert.deepEqual((await listed.json())[0].skills, ['loose-ends', 'llm-wiki'])
    // Editing something else keeps the missing name, rather than refusing the edit.
    const renamed = await instance.call('POST', `/profiles/${profile.id}`, { name: 'Renamed' })
    assert.equal(renamed.status, 200)
    assert.deepEqual((await renamed.json()).skills, ['loose-ends', 'llm-wiki'])
    // Re-sending the same selection is still allowed: it is what is already saved.
    const resent = await instance.call('POST', `/profiles/${profile.id}`, { skills: ['loose-ends', 'llm-wiki'] })
    assert.equal(resent.status, 200)
    // Deselecting it is how it goes away, and it cannot be brought back once gone.
    const dropped = await instance.call('POST', `/profiles/${profile.id}`, { skills: ['loose-ends'] })
    assert.deepEqual((await dropped.json()).skills, ['loose-ends'])
    const readded = await instance.call('POST', `/profiles/${profile.id}`, { skills: ['loose-ends', 'llm-wiki'] })
    assert.equal(readded.status, 400)
  } finally { await instance.api.close() }
})

test('a profile saved before skills existed loads, runs and edits with an empty selection', async () => {
  const instance = await setup({ skills: ['loose-ends'] })
  try {
    // The file the way it looked before this field existed: no skills key at all.
    const profile = { id: 'p_legacy', name: 'Legacy', role: 'Analyst', instructions: 'Check.', schedule: null, scheduleId: null, created: '2025-01-01T00:00:00.000Z', updated: '2025-01-01T00:00:00.000Z' }
    writeFileSync(join(instance.store.root, 'profiles', 'p_legacy.json'), JSON.stringify(profile))
    assert.deepEqual((await (await instance.call('GET', '/profiles')).json())[0].skills, [])
    assert.equal((await instance.call('POST', `/profiles/${profile.id}/run`)).status, 201)
    const edited = await instance.call('POST', `/profiles/${profile.id}`, { instructions: 'Check twice.' })
    assert.equal(edited.status, 200)
    assert.deepEqual((await edited.json()).skills, [])
  } finally { await instance.api.close() }
})

test('profile schedules use the latest profile when creating each goal', async () => {
  const instance = await setup()
  try {
    const at = new Date(Date.now() + 60_000).toISOString()
    const created = await instance.call('POST', '/profiles', {
      name: 'Morning research', role: 'Analyst', instructions: 'Use source A.',
      schedule: { trigger: { type: 'once', at }, priority: 2 },
    })
    assert.equal(created.status, 201)
    const profile = await created.json()
    assert.ok(profile.scheduleId)
    const linked = instance.store.getSchedule(profile.scheduleId)
    assert.equal(linked.profileId, profile.id)
    await instance.call('POST', `/profiles/${profile.id}`, { instructions: 'Use source B.' })
    const launched = await instance.call('POST', `/schedules/${profile.scheduleId}/run`)
    assert.equal(launched.status, 200)
    await instance.schedules?.idle?.()
    await new Promise((resolve) => setImmediate(resolve))
    const goal = instance.store.getGoal((await launched.json()).lastGoalId)
    assert.equal(goal.profileSnapshot.instructions, 'Use source B.')
    assert.equal(goal.title, 'Morning research')
    await instance.schedules.idle()
    const renamed = await instance.call('POST', `/profiles/${profile.id}`, { name: 'Updated research' })
    assert.equal(renamed.status, 200)
    assert.equal(instance.store.getSchedule(profile.scheduleId).status, 'completed')
  } finally { await instance.api.close() }
})

test('a host other than loopback without TLS is refused at startup', () => {
  assert.throws(() => createApi({ token: TOKEN, host: '0.0.0.0' }), /must present TLS/)
  assert.throws(() => createApi({ token: TOKEN, host: '11.0.0.163' }), /must present TLS/)
})

test('with TLS the service answers over https, and the token is still required', async () => {
  const s = await setup({ tls: await selfSigned() })
  try {
    assert.equal(s.api.tls, true)
    assert.ok(s.base.startsWith('https://'))
    assert.equal((await s.call('GET', '/board')).status, 200)
    assert.equal((await s.call('GET', '/board', null, 'wrong')).status, 401)
  } finally {
    await s.api.close()
  }
})

test('plain HTTP on loopback is still the default door', async () => {
  const s = await setup()
  assert.equal(s.api.tls, false)
  await s.api.close()
})

test('requests without the token are rejected', async () => {
  const s = await setup()
  try {
    assert.equal((await s.call('GET', '/board', null, 'wrong')).status, 401)
    assert.equal((await fetch(`${s.base}/board`)).status, 401)
  } finally {
    await s.api.close()
  }
})

test('creating a goal saves it, mirrors it and asks the coordinator to plan', async () => {
  const s = await setup()
  try {
    const res = await s.call('POST', '/goals', { title: 'Research bounties', outcome: 'A report' })
    assert.equal(res.status, 201)
    const goal = await res.json()
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(s.calls.plan, [goal.id])
    assert.deepEqual(s.calls.mirror, [goal.id])
    const board = await (await s.call('GET', '/board')).json()
    assert.equal(board.goals[0].title, 'Research bounties')
    assert.equal((await s.call('POST', '/goals', { title: 'no outcome' })).status, 400)
    assert.equal((await s.call('POST', '/goals', { title: 'x', outcome: 'y', recurring: { every: 'often' } })).status, 400)
  } finally {
    await s.api.close()
  }
})

test('goal changes: pause, resume, abandon and new information', async () => {
  const s = await setup()
  try {
    const g = s.store.newGoal({ title: 'G', outcome: 'O' })
    const t = s.store.newTask({ goalId: g.id, title: 'T', brief: 'b' })
    assert.equal((await (await s.call('POST', `/goals/${g.id}`, { action: 'pause' })).json()).status, 'paused')
    assert.equal((await (await s.call('POST', `/goals/${g.id}`, { action: 'resume' })).json()).status, 'active')
    await s.call('POST', `/goals/${g.id}`, { info: 'Use the beta branch' })
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(s.calls.redirect.at(-1), [g.id, 'Use the beta branch'])
    await s.call('POST', `/goals/${g.id}`, { action: 'pause' })
    const before = s.calls.redirect.length
    const resumed = await (await s.call('POST', `/goals/${g.id}`, { action: 'resume', info: 'Repository: /repo. Revise and retry the blocked inventory.' })).json()
    assert.equal(resumed.status, 'active')
    assert.equal(s.calls.redirect.length, before + 1)
    assert.deepEqual(s.calls.redirect.at(-1), [g.id, 'Repository: /repo. Revise and retry the blocked inventory.'])
    assert.equal((await (await s.call('POST', `/goals/${g.id}`, { action: 'abandon' })).json()).status, 'abandoned')
    assert.deepEqual(s.calls.cancel, [t.id])
    assert.equal((await s.call('POST', `/goals/${g.id}`, { action: 'explode' })).status, 400)
    assert.equal((await s.call('POST', '/goals/g_missing', { action: 'pause' })).status, 404)
  } finally {
    await s.api.close()
  }
})

test('approvals can be listed and decided; a bad decision is a 400', async () => {
  const s = await setup()
  try {
    const g = s.store.newGoal({ title: 'G', outcome: 'O' })
    const task = s.store.newTask({ goalId: g.id, title: 'T', brief: 'b' })
    const waiting = s.approvals.request({ task, category: 'money', action: 'pay', detail: 'x' })
    const [a] = await (await s.call('GET', '/approvals')).json()
    assert.equal((await s.call('POST', `/approvals/${a.id}`, { decision: 'maybe' })).status, 400)
    assert.equal((await s.call('POST', `/approvals/${a.id}`, { decision: 'approve' })).status, 200)
    assert.deepEqual(await waiting, { approved: true, note: null })
    assert.equal((await s.call('POST', `/approvals/${a.id}`, { decision: 'deny' })).status, 400)
  } finally {
    await s.api.close()
  }
})

test('status, cancel and cleanup routes', async () => {
  const s = await setup()
  try {
    s.store.newGoal({ title: 'Ship it', outcome: 'O' })
    const { text } = await (await s.call('GET', '/status')).json()
    assert.match(text, /Ship it/)
    assert.equal((await s.call('POST', '/tasks/t_1/cancel')).status, 200)
    assert.deepEqual(await (await s.call('POST', '/cleanup')).json(), { removed: ['t_1'] })
    assert.equal((await s.call('GET', '/nowhere')).status, 404)
  } finally {
    await s.api.close()
  }
})

test('the event stream delivers new events', async () => {
  const s = await setup()
  try {
    const controller = new AbortController()
    const res = await fetch(`${s.base}/events`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: controller.signal })
    assert.equal(res.headers.get('content-type'), 'text/event-stream')
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    s.store.appendEvent({ type: 'goal_done', text: 'Goal complete: X' })
    let buf = ''
    while (!buf.includes('goal_done')) buf += decoder.decode((await reader.read()).value)
    assert.match(buf, /data: \{.*"type":"goal_done"/)
    controller.abort()
  } finally {
    await s.api.close()
  }
})

test('the server listens on loopback only', async () => {
  const s = await setup()
  try {
    const port = Number(new URL(s.base).port)
    await assert.rejects(fetch(`http://[::1]:${port}/board`))
  } finally {
    await s.api.close()
  }
})

test('the briefing is short and speakable', () => {
  const store = createStore(mkdtempSync(join(tmpdir(), 'agents-brief-')), { workDir: '/work' })
  assert.equal(briefing(store), 'No agent work is in progress.')
  const g = store.newGoal({ title: 'Release stealthDash', outcome: 'Tagged' })
  const a = store.newTask({ goalId: g.id, title: 'CI', brief: 'b' })
  store.newTask({ goalId: g.id, title: 'Notes', brief: 'b' })
  store.saveTask({ ...a, status: 'done' })
  assert.equal(briefing(store), 'One goal in progress. Release stealthDash: 1 of 2 tasks done, 1 queued.')
  assert.match(briefing(store, g.id), /Release stealthDash\. Done means: Tagged\./)
  const board = boardOf(store, new Set([a.id]))
  assert.deepEqual(board.running, [a.id])
  assert.equal(board.goals[0].tasks.length, 2)
})

test('F11: the board leaves out archived tasks', () => {
  const store = createStore(mkdtempSync(join(tmpdir(), 'agents-board11-')), { workDir: '/work' })
  const g = store.newGoal({ title: 'G', outcome: 'O' })
  store.saveTask({ ...store.newTask({ goalId: g.id, title: 'Old', brief: 'b' }), status: 'done', archived: true })
  store.newTask({ goalId: g.id, title: 'New', brief: 'b' })
  assert.deepEqual(boardOf(store).goals[0].tasks.map((t) => t.title), ['New'])
})

// -- the capacity readout ---------------------------------------------------

test('history-inclusive board API returns completed goals and archived task results', async () => {
  const setupState = await setup()
  try {
    const goal = setupState.store.newGoal({ title: 'Completed research', outcome: 'Report' })
    setupState.store.saveGoal({ ...goal, status: 'done' })
    const task = setupState.store.newTask({ goalId: goal.id, title: 'Archived result', brief: 'Research' })
    setupState.store.saveTask({ ...task, status: 'done', archived: true, result: { summary: 'Report finished', artifacts: ['/work/report.txt'] } })
    const headers = { authorization: `Bearer ${TOKEN}` }
    const normal = await (await fetch(`${setupState.base}/board`, { headers })).json()
    assert.equal(normal.goals.length, 0)
    const history = await (await fetch(`${setupState.base}/board?history=1`, { headers })).json()
    assert.equal(history.goals[0].tasks[0].summary, 'Report finished')
    assert.deepEqual(history.goals[0].tasks[0].result.artifacts, ['/work/report.txt'])
    assert.equal(history.goals[0].tasks[0].workspace, task.workspace.path)
    assert.equal(history.goals[0].tasks[0].archived, true)
  } finally {
    await setupState.api.close()
  }
})

test('the board marks explicit user-response blockers, but not ordinary pauses or blockers', async () => {
  const instance = await setup()
  try {
    const escalated = instance.store.newGoal({ title: 'Needs a decision', outcome: 'Choose a repo' })
    instance.store.saveGoal({ ...escalated, status: 'paused' })
    instance.store.appendEvent({ type: 'goal_paused', goalId: escalated.id, data: { reason: 'Which repo?' } })
    const credential = instance.store.newTask({ goalId: escalated.id, title: 'Needs credentials', brief: 'Ask for a token' })
    instance.store.saveTask({ ...credential, status: 'blocked', failure: { blocker: 'credential', need: ['API token'] } })
    const upstream = instance.store.newTask({ goalId: escalated.id, title: 'Wait for upstream', brief: 'Wait' })
    instance.store.saveTask({ ...upstream, status: 'blocked', failure: { blocker: 'upstream', need: ['Release'] } })
    const manual = instance.store.newGoal({ title: 'Manually paused', outcome: 'Continue later' })
    await instance.call('POST', `/goals/${manual.id}`, { action: 'pause' })
    const board = await (await instance.call('GET', '/board')).json()
    const goals = new Map(board.goals.map((goal) => [goal.id, goal]))
    assert.equal(goals.get(escalated.id).awaitingResponse, true)
    assert.equal(goals.get(manual.id).awaitingResponse, false)
    assert.equal(goals.get(escalated.id).tasks.find((task) => task.id === credential.id).awaitingResponse, true)
    assert.equal(goals.get(escalated.id).tasks.find((task) => task.id === upstream.id).awaitingResponse, false)
  } finally { await instance.api.close() }
})

test('GET /endpoints reports the pool, its width and what is busy', async () => {
  const pool = createPool({
    endpoints: parseEndpoints([
      { id: 'cloud', kind: 'anthropic', concurrency: 2 },
      { id: 'rigel', kind: 'gateway', baseURL: 'http://11.0.0.9:4000', model: 'llama3.1:8b', apiKeyEnv: 'RIGEL_KEY' },
    ]),
  })
  pool.acquire({ model: 'rigel' })
  const s = await setup({ pool })
  try {
    const res = await s.call('GET', '/endpoints')
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.capacity, 3)
    assert.equal(body.running, 1)
    assert.deepEqual(body.endpoints.map((e) => [e.id, e.running, e.concurrency]), [['cloud', 0, 2], ['rigel', 1, 1]])
    // No addresses and no key names go out of the process.
    assert.doesNotMatch(JSON.stringify(body), /11\.0\.0\.9|RIGEL_KEY/)
  } finally {
    await s.api.close()
  }
})

test('with no pool configured the readout still answers, from the running set', async () => {
  const s = await setup()
  try {
    const body = await (await s.call('GET', '/endpoints')).json()
    assert.deepEqual(body, { capacity: null, running: 0, endpoints: [] })
  } finally {
    await s.api.close()
  }
})

test('erasing a goal is refused while it is live and removes everything once it is not', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'agents-work-'))
  const s = await setup({ workDir })
  try {
    const goal = s.store.newGoal({ title: 'Ship it', outcome: 'Released' })
    const task = s.store.newTask({ goalId: goal.id, title: 'Research', brief: 'b' })
    s.approvals.request({ task, category: 'money', action: 'pay', detail: 'x' })
    mkdirSync(task.workspace.path, { recursive: true })
    writeFileSync(join(task.workspace.path, 'report.md'), 'saved output')

    // Active: the guard is the service's, not the button's.
    const live = await s.call('POST', `/goals/${goal.id}`, { action: 'erase' })
    assert.equal(live.status, 400)
    assert.match((await live.json()).error, /still active/)
    assert.equal(s.store.getGoal(goal.id).id, goal.id)

    s.store.saveGoal({ ...s.store.getGoal(goal.id), status: 'done' })

    // Stopped goal, but a task the scheduler still has in flight.
    s.store.saveTask({ ...s.store.getTask(task.id), status: 'running' })
    const busy = await s.call('POST', `/goals/${goal.id}`, { action: 'erase' })
    assert.equal(busy.status, 400)
    assert.match((await busy.json()).error, /Research.*still running/)
    assert.equal(s.store.listTasks({ goalId: goal.id }).length, 1)

    // Still refused when only the live running set knows the task is busy.
    s.store.saveTask({ ...s.store.getTask(task.id), status: 'queued' })
    s.running.add(task.id)
    assert.equal((await s.call('POST', `/goals/${goal.id}`, { action: 'erase' })).status, 400)
    s.running.delete(task.id)

    s.store.saveTask({ ...s.store.getTask(task.id), status: 'done' })
    const erased = await s.call('POST', `/goals/${goal.id}`, { action: 'erase' })
    assert.equal(erased.status, 200)
    assert.deepEqual(await erased.json(), { id: goal.id, deleted: true, tasks: 1 })
    assert.equal(s.store.getGoal(goal.id), null)
    assert.deepEqual(s.store.listTasks({ goalId: goal.id }), [])
    assert.deepEqual(s.store.listApprovals(), [])
    assert.equal(existsSync(task.workspace.path), false)
    assert.equal(existsSync(s.store.goalOutputDir(goal.id)), false)
    assert.equal(s.store.readEvents().filter((event) => event.type === 'goal_deleted').length, 1)
    assert.equal(boardOf(s.store, new Set(), { history: true }).goals.length, 0)

    // Gone is gone: a repeat is a 404, not a second cascade.
    assert.equal((await s.call('POST', `/goals/${goal.id}`, { action: 'erase' })).status, 404)
  } finally {
    await s.api.close()
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('an abandoned goal can be erased and its event names what went', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'agents-work-'))
  const s = await setup({ workDir })
  try {
    const goal = s.store.newGoal({ title: 'Stale plan', outcome: 'O' })
    s.store.newTask({ goalId: goal.id, title: 'One', brief: 'b' })
    s.store.newTask({ goalId: goal.id, title: 'Two', brief: 'b' })
    assert.equal((await (await s.call('POST', `/goals/${goal.id}`, { action: 'abandon' })).json()).status, 'abandoned')
    const erased = await (await s.call('POST', `/goals/${goal.id}`, { action: 'erase' })).json()
    assert.deepEqual(erased, { id: goal.id, deleted: true, tasks: 2 })
    const event = s.store.readEvents().find((entry) => entry.type === 'goal_deleted')
    assert.equal(event.goalId, goal.id)
    assert.deepEqual(event.data, { title: 'Stale plan', tasks: 2 })
  } finally {
    await s.api.close()
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('erasing a goal id that was never created fails cleanly with 404, no event and no store change', async () => {
  const s = await setup()
  try {
    const kept = s.store.newGoal({ title: 'Keep it', outcome: 'Kept' })
    s.store.newTask({ goalId: kept.id, title: 'Unrelated', brief: 'b' })
    const eventsBefore = s.store.readEvents().length

    const missing = await s.call('POST', '/goals/g_never_existed', { action: 'erase' })
    assert.equal(missing.status, 404)
    assert.ok(s.store.listGoals().map((entry) => entry.id).includes(kept.id))
    assert.equal(s.store.listTasks({ goalId: kept.id }).length, 1)
    assert.equal(s.store.readEvents().length, eventsBefore)
  } finally {
    await s.api.close()
  }
})

test('erasing one finished goal never touches another goal, its tasks, approvals or saved workspace', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'agents-work-'))
  const s = await setup({ workDir })
  try {
    const gone = s.store.newGoal({ title: 'Ship it', outcome: 'Released' })
    s.store.newTask({ goalId: gone.id, title: 'Research', brief: 'b' })
    s.store.saveGoal({ ...s.store.getGoal(gone.id), status: 'done' })

    const kept = s.store.newGoal({ title: 'Still active', outcome: 'Later' })
    const keptTask = s.store.newTask({ goalId: kept.id, title: 'Unrelated', brief: 'b' })
    const keptApproval = s.store.newApproval({ taskId: keptTask.id, category: 'shell', action: 'ls', detail: 'list' })
    mkdirSync(keptTask.workspace.path, { recursive: true })
    writeFileSync(join(keptTask.workspace.path, 'report.md'), 'kept output')

    const erased = await s.call('POST', `/goals/${gone.id}`, { action: 'erase' })
    assert.equal(erased.status, 200)

    assert.equal(s.store.getGoal(kept.id).id, kept.id)
    assert.deepEqual(s.store.listTasks({ goalId: kept.id }).map((entry) => entry.id), [keptTask.id])
    assert.deepEqual(s.store.listApprovals().map((entry) => entry.id), [keptApproval.id])
    assert.equal(existsSync(keptTask.workspace.path), true)
    assert.equal(existsSync(join(keptTask.workspace.path, 'report.md')), true)
    assert.equal(existsSync(s.store.goalOutputDir(kept.id)), true)
    assert.equal(s.store.getGoal(gone.id), null)
    assert.deepEqual(s.store.listTasks({ goalId: gone.id }), [])
  } finally {
    await s.api.close()
    rmSync(workDir, { recursive: true, force: true })
  }
})
