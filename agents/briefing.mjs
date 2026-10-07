/**
 * What the board shows and what JARVIS says when asked for a status report.
 * The spoken form is one short sentence per goal — detail lives on the board.
 */

import { scheduleModels } from './text-query.mjs'

const VISIBLE = ['active', 'paused']
const byPriority = (a, b) => a.priority - b.priority || a.created.localeCompare(b.created)
const count = (n, word) => `${n === 1 ? 'One' : n} ${word}${n === 1 ? '' : 's'}`

export function boardOf(store, running = new Set(), { history = false } = {}) {
  const tasks = store.listTasks().filter((t) => history || !t.archived).sort((a, b) => a.created.localeCompare(b.created))
  const events = store.readEvents({ limit: 5000 })
  const progress = history ? new Map(events.filter((event) => event.type === 'task_progress').map((event) => [event.taskId, event])) : null
  const awaitingResponse = new Map()
  for (const event of events) {
    if (event.type === 'goal_paused') {
      awaitingResponse.set(event.goalId, event.data?.awaitingResponse === true || Boolean(event.data?.reason && event.data.reason !== 'repeated plan'))
    } else if (event.type === 'goal_changed' && ['pause', 'resume', 'abandon'].includes(event.data?.action) || event.type === 'goal_done') {
      awaitingResponse.set(event.goalId, false)
    }
  }
  const latestScheduled = new Set(store.listSchedules().filter((schedule) => schedule.status !== 'deleted').map((schedule) => schedule.lastGoalId))
  return {
    scheduleModels: scheduleModels(),
    schedules: store.listSchedules().filter((schedule) => schedule.status !== 'deleted').map((schedule) => {
      const goal = schedule.lastGoalId && store.getGoal(schedule.lastGoalId)
      const latest = goal ? store.listTasks({ goalId: goal.id }).sort((first, second) => second.updated.localeCompare(first.updated))[0] : null
      return { ...schedule, lastStatus: goal?.status ?? null, lastSummary: goal?.notes || latest?.result?.summary || latest?.failure?.detail || null }
    }),
    goals: store
      .listGoals()
      .filter((g) => history || VISIBLE.includes(g.status) || latestScheduled.has(g.id))
      .sort(byPriority)
      .map((g) => ({
        ...g,
        awaitingResponse: g.status === 'paused' && awaitingResponse.get(g.id) === true,
        tasks: tasks
          .filter((t) => t.goalId === g.id)
          .map((t) => ({
            id: t.id,
            title: t.title,
            kind: t.kind,
            status: t.status,
            attempts: t.attempts,
            summary: t.result?.summary ?? t.failure?.detail ?? null,
            awaitingResponse: t.status === 'blocked' && ['credential', 'decision'].includes(t.failure?.blocker),
            // The board sorts every kind of agent on one timeline, so a task
            // has to carry the same stamps a subagent does.
            created: t.created,
            updated: t.updated,
            model: t.model ?? null,
            runtime: t.runtime ?? null,
            remote: t.remote ? { endpointId: t.remote.endpointId } : null,
            origin: t.origin?.label ? { label: t.origin.label } : null,
            ...(history && {
              result: t.result ?? null,
              failure: t.failure ?? null,
              workspace: t.workspace?.path ?? null,
              archived: Boolean(t.archived),
              remote: t.remote ? { endpointId: t.remote.endpointId, taskId: t.remote.taskId } : null,
              progress: progress.get(t.id) ?? null,
            }),
          })),
      })),
    approvals: store.listApprovals('pending'),
    running: [...running],
  }
}

function goalLine(goal, tasks) {
  const live = tasks.filter((t) => t.status !== 'cancelled')
  const done = live.filter((t) => t.status === 'done').length
  const parts = [`${done} of ${live.length} task${live.length === 1 ? '' : 's'} done`]
  for (const [status, label] of [
    ['running', 'running'], ['awaiting_approval', 'awaiting approval'], ['blocked', 'blocked'],
    ['failed', 'failed'], ['queued', 'queued'],
  ]) {
    const n = live.filter((t) => t.status === status).length
    if (n) parts.push(`${n} ${label}`)
  }
  return `${goal.title}${goal.status === 'paused' ? ' (paused)' : ''}: ${parts.join(', ')}.`
}

export function briefing(store, goalId) {
  if (goalId) {
    const goal = store.getGoal(goalId)
    if (!goal) return `There is no goal ${goalId}.`
    const tasks = store.listTasks({ goalId }).filter((t) => !t.archived).sort((a, b) => a.created.localeCompare(b.created))
    return [
      `${goal.title}. Done means: ${goal.outcome}. Status: ${goal.status}.`,
      goal.notes ? `Note: ${goal.notes}` : '',
      ...tasks.map((t) => `${t.title}: ${t.status.replace('_', ' ')}${t.result?.summary ? ` — ${t.result.summary}` : t.failure?.detail ? ` — ${t.failure.detail}` : ''}.`),
    ].filter(Boolean).join('\n')
  }
  const goals = store.listGoals().filter((g) => VISIBLE.includes(g.status)).sort(byPriority)
  if (!goals.length) return 'No agent work is in progress.'
  const tasks = store.listTasks().filter((t) => !t.archived)
  const lines = goals.map((g) => goalLine(g, tasks.filter((t) => t.goalId === g.id)))
  const pending = store.listApprovals('pending')
  const tail = pending.length ? ` ${count(pending.length, 'approval')} waiting: ${pending.map((a) => a.action).join('; ')}.` : ''
  return `${count(goals.length, 'goal')} in progress. ${lines.join(' ')}${tail}`
}
