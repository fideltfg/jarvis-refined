import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'

/**
 * Where a task works. Code tasks get a git worktree on their own branch, so an
 * agent never touches the tree the user has checked out; everything else gets
 * a scratch folder. Workspaces outlive their tasks — branches and PRs point at
 * them — and are only removed by an explicit cleanup.
 */

const git = (args, cwd) =>
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })

const branchExists = (repo, branch) => {
  try {
    git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo)
    return true
  } catch {
    return false
  }
}

export function prepareWorkspace(task) {
  const { path, repo, branch } = task.workspace
  if (existsSync(path)) return path
  if (task.kind === 'code' && repo) {
    git(branchExists(repo, branch) ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path], repo)
  } else {
    mkdirSync(path, { recursive: true })
  }
  return path
}

export function removeWorkspace(task) {
  const { path, repo } = task.workspace
  if (!existsSync(path)) return false
  if (task.kind === 'code' && repo) git(['worktree', 'remove', '--force', path], repo)
  else rmSync(path, { recursive: true, force: true })
  return true
}

export function cleanupWorkspaces(store) {
  const goals = new Map(store.listGoals().map((g) => [g.id, g]))
  const removed = []
  for (const task of store.listTasks()) {
    if (task.status === 'running' || task.status === 'awaiting_approval') continue
    const finished = task.status === 'cancelled' || task.archived || ['done', 'abandoned'].includes(goals.get(task.goalId)?.status)
    if (!finished) continue
    try {
      if (removeWorkspace(task)) removed.push(task.id)
    } catch (err) {
      console.warn(`[agents] could not remove ${task.workspace.path}: ${err.message}`)
    }
  }
  return removed
}
