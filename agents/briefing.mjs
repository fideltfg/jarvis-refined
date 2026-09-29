/**
 * What the board shows and what JARVIS says when asked for a status report.
 * The spoken form is one short sentence per goal — detail lives on the board.
 */

const VISIBLE = ['active', 'paused']
const byPriority = (a, b) => a.priority - b.priority || a.created.localeCompare(b.created)
const count = (n, word) => `${n === 1 ? 'One' : n} ${word}${n === 1 ? '' : 's'}`

export function boardOf(store, running = new Set()) {
  const tasks = store.listTasks().filter((t) => !t.archived).sort((a, b) => a.created.localeCompare(b.created))
  return {
    goals: store
      .listGoals()
      .filter((g) => VISIBLE.includes(g.status))
      .sort(byPriority)
      .map((g) => ({
        ...g,
        tasks: tasks
          .filter((t) => t.goalId === g.id)
          .map((t) => ({
            id: t.id,
            title: t.title,
            kind: t.kind,
            status: t.status,
            attempts: t.attempts,
            summary: t.result?.summary ?? t.failure?.detail ?? null,
            // The board sorts every kind of agent on one timeline, so a task
            // has to carry the same stamps a subagent does.
            created: t.created,
            updated: t.updated,
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
