import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from './store.mjs'
import { cleanupWorkspaces, prepareWorkspace, removeWorkspace } from './workspace.mjs'

/** Run a git command in a fixture repository and return its text output. */
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' })

/** Create a committed repository suitable for worktree lifecycle checks. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'agents-repo-'))
  git(['init', '-q', '-b', 'main'], dir)
  git(['config', 'user.email', 't@t'], dir)
  git(['config', 'user.name', 't'], dir)
  writeFileSync(join(dir, 'README.md'), 'hi\n')
  git(['add', '.'], dir)
  git(['commit', '-qm', 'init'], dir)
  return dir
}

/** Create an isolated agent store, work root, and owning goal. */
function setup() {
  const work = mkdtempSync(join(tmpdir(), 'agents-work-'))
  const store = createStore(mkdtempSync(join(tmpdir(), 'agents-ws-')), { workDir: work })
  const goal = store.newGoal({ title: 'G', outcome: 'O' })
  return { store, goal, work }
}

// Verifies code tasks receive a branch-isolated worktree and prepare is idempotent.
test('a code task gets a worktree on its own branch, and a second prepare is a no-op', () => {
  const { store, goal } = setup()
  const r = repo()
  const task = store.newTask({ goalId: goal.id, title: 'Fix', brief: 'b', kind: 'code', repo: r })
  const path = prepareWorkspace(task)
  assert.ok(existsSync(join(path, 'README.md')))
  assert.equal(git(['branch', '--show-current'], path).trim(), task.workspace.branch)
  assert.equal(prepareWorkspace(task), path)
})

// Ensures removed code workspaces can be recreated on their original branch.
test('a worktree is recreated on an existing branch after removal', () => {
  const { store, goal } = setup()
  const r = repo()
  const task = store.newTask({ goalId: goal.id, title: 'Fix', brief: 'b', kind: 'code', repo: r })
  prepareWorkspace(task)
  assert.equal(removeWorkspace(task), true)
  assert.ok(!existsSync(task.workspace.path))
  prepareWorkspace(task)
  assert.equal(git(['branch', '--show-current'], task.workspace.path).trim(), task.workspace.branch)
})

// Checks non-code tasks use scratch directories with standard output folders.
test('other kinds get a plain folder', () => {
  const { store, goal, work } = setup()
  const task = store.newTask({ goalId: goal.id, title: 'Read', brief: 'b' })
  assert.equal(task.workspace.path, join(work, 'goals', goal.id, 'tasks', task.id))
  assert.ok(existsSync(prepareWorkspace(task)))
  for (const name of ['reports', 'artifacts', 'logs', 'tmp']) assert.ok(existsSync(join(task.workspace.path, name)))
  assert.equal(removeWorkspace(task), true)
  assert.equal(removeWorkspace(task), false)
})

// Preserves legacy workspace paths while adding newly required output folders.
test('existing task workspaces retain their path and gain output folders', () => {
  const { store, goal, work } = setup()
  const task = store.newTask({ goalId: goal.id, title: 'Legacy', brief: 'b' })
  task.workspace.path = join(work, task.id)
  assert.equal(prepareWorkspace(task), task.workspace.path)
  for (const name of ['reports', 'artifacts', 'logs', 'tmp']) assert.ok(existsSync(join(task.workspace.path, name)))
})

// Removes only terminal task workspaces, leaving active goal work intact.
test('cleanup removes workspaces of finished goals and cancelled tasks only', () => {
  const { store, goal } = setup()
  const done = store.newGoal({ title: 'Done', outcome: 'O' })
  const keep = store.newTask({ goalId: goal.id, title: 'Keep', brief: 'b' })
  const gone = store.newTask({ goalId: done.id, title: 'Gone', brief: 'b' })
  const cancelled = store.saveTask({ ...store.newTask({ goalId: goal.id, title: 'X', brief: 'b' }), status: 'cancelled' })
  for (const t of [keep, gone, cancelled]) prepareWorkspace(t)
  store.saveGoal({ ...done, status: 'done' })
  assert.deepEqual(cleanupWorkspaces(store).sort(), [gone.id, cancelled.id].sort())
  assert.ok(existsSync(keep.workspace.path))
})

// Confirms archived tasks are removable even while their parent goal remains live.
test('F11: cleanup also removes archived tasks of a live goal', () => {
  const { store, goal } = setup()
  const old = store.saveTask({ ...store.newTask({ goalId: goal.id, title: 'Old', brief: 'b' }), status: 'done', archived: true })
  prepareWorkspace(old)
  assert.deepEqual(cleanupWorkspaces(store), [old.id])
})
