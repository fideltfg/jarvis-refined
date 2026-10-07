import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore, parseEvery, slug } from './store.mjs'

const fresh = (opts) => {
  const root = mkdtempSync(join(tmpdir(), 'agents-store-'))
  return { root, store: createStore(root, { workDir: '/work', ...opts }) }
}

test('a goal round-trips and priority is clamped to 1..5', () => {
  const { store } = fresh()
  const g = store.newGoal({ title: 'Ship it', outcome: 'Released', priority: 9 })
  assert.equal(store.getGoal(g.id).title, 'Ship it')
  assert.equal(g.priority, 5)
  assert.equal(g.status, 'active')
  assert.equal(g.taskCap, 20)
  assert.ok(g.updated)
})

test('a goal needs a title and an outcome', () => {
  const { store } = fresh()
  assert.throws(() => store.newGoal({ title: 'x' }), /title and an outcome/)
})

test('a malformed recurring interval is refused at creation', () => {
  const { store } = fresh()
  assert.throws(() => store.newGoal({ title: 'x', outcome: 'y', recurring: { every: 'every 6 hours' } }), /Cannot read the interval/)
  const ok = store.newGoal({ title: 'x', outcome: 'y', recurring: { every: '6h' } })
  assert.deepEqual(ok.recurring, { every: '6h' })
})

test('parseEvery reads minutes, hours and days', () => {
  assert.equal(parseEvery('30m'), 30 * 60_000)
  assert.equal(parseEvery('6h'), 6 * 3_600_000)
  assert.equal(parseEvery('1d'), 86_400_000)
  assert.throws(() => parseEvery('soon'), /Cannot read the interval/)
})

test('a task takes its budget from its kind and a code task gets a branch', () => {
  const { store } = fresh()
  const g = store.newGoal({ title: 'G', outcome: 'O' })
  const t = store.newTask({ goalId: g.id, title: 'Fix the CI', brief: 'b', kind: 'code', repo: '/repo' })
  assert.deepEqual(t.budget, { maxTurns: 60, maxMinutes: 45, maxUsd: 5 })
    assert.equal(t.workspace.path, `/work/goals/${g.id}/tasks/${t.id}`)
  assert.equal(t.workspace.repo, '/repo')
  assert.match(t.workspace.branch, /^jarvis\/fix-the-ci-[0-9a-f]{4}$/)
  assert.equal(t.status, 'queued')
  assert.equal(t.attempts, 0)
  assert.equal(t.model, 'sonnet')
  const r = store.newTask({ goalId: g.id, title: 'Read up', brief: 'b' })
  assert.deepEqual(r.workspace, { path: `/work/goals/${g.id}/tasks/${r.id}` })
  assert.equal(r.kind, 'research')
  assert.deepEqual(r.allowedSkills, [])
  const skilled = store.newTask({ goalId: g.id, title: 'Special research', brief: 'b', allowedSkills: ['small-skill'] })
  assert.deepEqual(store.getTask(skilled.id).allowedSkills, ['small-skill'])
})

test('an unknown kind is refused', () => {
  const { store } = fresh()
  assert.throws(() => store.newTask({ goalId: 'g', title: 't', brief: 'b', kind: 'magic' }), /Unknown task kind/)
})

test('listTasks filters by field', () => {
  const { store } = fresh()
  const g = store.newGoal({ title: 'G', outcome: 'O' })
  const a = store.newTask({ goalId: g.id, title: 'A', brief: 'a' })
  store.newTask({ goalId: 'other', title: 'B', brief: 'b' })
  store.saveTask({ ...a, status: 'done' })
  assert.equal(store.listTasks({ goalId: g.id }).length, 1)
  assert.equal(store.listTasks({ status: 'done' })[0].id, a.id)
})

test('a hand-edited file that no longer parses is skipped, not fatal', () => {
  const { root, store } = fresh()
  store.newGoal({ title: 'Good', outcome: 'O' })
  writeFileSync(join(root, 'goals', 'broken.json'), '{ not json')
  const goals = store.listGoals()
  assert.equal(goals.length, 1)
  assert.equal(goals[0].title, 'Good')
})

test('saves leave no temp files behind', () => {
  const { root, store } = fresh()
  const g = store.newGoal({ title: 'G', outcome: 'O' })
  store.saveGoal({ ...g, notes: 'n' })
  assert.deepEqual(readdirSync(join(root, 'goals')).filter((f) => f.endsWith('.tmp')), [])
})

test('events are appended, readable and delivered to listeners', () => {
  const { store } = fresh()
  const seen = []
  const off = store.onEvent((e) => seen.push(e.type))
  store.appendEvent({ type: 'goal_created', text: 'x' })
  off()
  store.appendEvent({ type: 'goal_done', text: 'y' })
  assert.deepEqual(seen, ['goal_created'])
  assert.deepEqual(store.readEvents().map((e) => e.type), ['goal_created', 'goal_done'])
  assert.ok(store.readEvents()[0].at)
})

test('slug makes a short branch-safe name', () => {
  assert.equal(slug('Fix the CI pipeline!'), 'fix-the-ci-pipeline')
  assert.equal(slug('***'), 'task')
})
