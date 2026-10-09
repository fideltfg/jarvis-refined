/**
 * What the board shows and what JARVIS says when asked for a status report.
 * The spoken form is one short sentence per goal — detail lives on the board.
 */

import { scheduleModels } from './text-query.mjs'
import { taskReferences } from './reports.mjs'

const VISIBLE = ['active', 'paused']
/** Sort goals by priority while keeping creation order stable for ties. */
const byPriority = (a, b) => a.priority - b.priority || a.created.localeCompare(b.created)
/** Format a count as a short spoken singular/plural phrase. */
const count = (n, word) => `${n === 1 ? 'One' : n} ${word}${n === 1 ? '' : 's'}`

/** Build the board payload, including optional archived history and progress. */
export function boardOf(store, running = new Set(), { history = false } = {}) {
  const tasks = store.listTasks().filter((task) => {
    // Hide archived tasks in the live board, but retain them in history mode.
    return history || !task.archived
  }).sort((first, second) => {
    // Preserve creation order for stable task and dependency presentation.
    return first.created.localeCompare(second.created)
  })
  const events = store.readEvents({ limit: 5000 })
  const progress = history ? new Map(events.filter((event) => {
    // Include progress snapshots only when archived history is requested.
    return event.type === 'task_progress'
  }).map((event) => {
    // Keep the latest event for each task id in the event stream order.
    return [event.taskId, event]
  })) : null
  const awaitingResponse = new Map()
  for (const event of events) {
    if (event.type === 'goal_paused') {
      awaitingResponse.set(event.goalId, event.data?.awaitingResponse === true || Boolean(event.data?.reason && event.data.reason !== 'repeated plan'))
    } else if (event.type === 'goal_changed' && ['pause', 'resume', 'abandon'].includes(event.data?.action) || event.type === 'goal_done') {
      awaitingResponse.set(event.goalId, false)
    }
  }
  const latestScheduled = new Set(store.listSchedules().filter((schedule) => {
    // Exclude deleted schedules before retaining their latest goal.
    return schedule.status !== 'deleted'
  }).map((schedule) => {
    // Keep the goal id used to show a schedule's most recent run.
    return schedule.lastGoalId
  }))
  return {
    scheduleModels: scheduleModels(),
    schedules: store.listSchedules().filter((schedule) => {
      // Do not expose deleted schedules on the active board.
      return schedule.status !== 'deleted'
    }).map((schedule) => {
      // Derive the latest run status and summary from its goal and newest task.
      const goal = schedule.lastGoalId && store.getGoal(schedule.lastGoalId)
      const latest = goal ? store.listTasks({ goalId: goal.id }).sort((first, second) => second.updated.localeCompare(first.updated))[0] : null
      return { ...schedule, lastStatus: goal?.status ?? null, lastSummary: goal?.notes || latest?.result?.summary || latest?.failure?.detail || null }
    }),
    goals: store
      .listGoals()
      .filter((goal) => {
        // Include active work and completed history only when requested.
        return history || VISIBLE.includes(goal.status) || latestScheduled.has(goal.id)
      })
      .sort(byPriority)
      .map((g) => ({
        ...g,
        awaitingResponse: g.status === 'paused' && awaitingResponse.get(g.id) === true,
        tasks: tasks
          .filter((task) => {
            // Attach only tasks owned by the current goal.
            return task.goalId === g.id
          })
          .map((task) => ({
            id: task.id,
            title: task.title,
            kind: task.kind,
            status: task.status,
            attempts: task.attempts,
            summary: task.result?.summary ?? task.failure?.detail ?? null,
            questions: task.failure?.questions ?? [],
            references: taskReferences(task),
            failure: task.failure ?? null,
            awaitingResponse: task.status === 'blocked' && ['credential', 'decision'].includes(task.failure?.blocker),
            // The board sorts every kind of agent on one timeline, so a task
            // has to carry the same stamps a subagent does.
            created: task.created,
            updated: task.updated,
            model: task.model ?? null,
            runtime: task.runtime ?? null,
            remote: task.remote ? { endpointId: task.remote.endpointId } : null,
            origin: task.origin?.label ? { label: task.origin.label } : null,
            ...(history && {
              result: task.result ?? null,
              failure: task.failure ?? null,
              workspace: task.workspace?.path ?? null,
              archived: Boolean(task.archived),
              remote: task.remote ? { endpointId: task.remote.endpointId, taskId: task.remote.taskId } : null,
              progress: progress.get(task.id) ?? null,
            }),
          })),
      })),
    approvals: store.listApprovals('pending'),
    running: [...running],
  }
}

/** Summarize one goal's non-cancelled task counts as a speakable sentence. */
function goalLine(goal, tasks) {
  const live = tasks.filter((task) => {
    // Cancelled tasks no longer contribute to progress counts.
    return task.status !== 'cancelled'
  })
  const done = live.filter((task) => {
    // Count only completed work toward the goal's done total.
    return task.status === 'done'
  }).length
  const parts = [`${done} of ${live.length} task${live.length === 1 ? '' : 's'} done`]
  for (const [status, label] of [
    ['running', 'running'], ['awaiting_approval', 'awaiting approval'], ['blocked', 'blocked'],
    ['failed', 'failed'], ['queued', 'queued'],
  ]) {
    const n = live.filter((task) => {
      // Add a status count only for tasks currently in that state.
      return task.status === status
    }).length
    if (n) parts.push(`${n} ${label}`)
  }
  return `${goal.title}${goal.status === 'paused' ? ' (paused)' : ''}: ${parts.join(', ')}.`
}

/** Produce a concise status briefing for one goal or all visible goals. */
export function briefing(store, goalId) {
  if (goalId) {
    const goal = store.getGoal(goalId)
    if (!goal) return `There is no goal ${goalId}.`
    const tasks = store.listTasks({ goalId }).filter((task) => {
      // Completed archived task detail belongs in the board's history view.
      return !task.archived
    }).sort((first, second) => first.created.localeCompare(second.created))
    return [
      `${goal.title}. Done means: ${goal.outcome}. Status: ${goal.status}.`,
      goal.notes ? `Note: ${goal.notes}` : '',
      ...tasks.map((task) => {
        // Include each task's state and whichever result detail is available.
        return `${task.title}: ${task.status.replace('_', ' ')}${task.result?.summary ? ` — ${task.result.summary}` : task.failure?.detail ? ` — ${task.failure.detail}` : ''}.`
      }),
    ].filter((line) => {
      // Omit the optional note line when the goal has no note.
      return Boolean(line)
    }).join('\n')
  }
  const goals = store.listGoals().filter((goal) => {
    // Spoken status includes active and paused goals, not completed history.
    return VISIBLE.includes(goal.status)
  }).sort(byPriority)
  if (!goals.length) return 'No agent work is in progress.'
  const tasks = store.listTasks().filter((task) => {
    // Exclude archived executions from current progress totals.
    return !task.archived
  })
  const lines = goals.map((goal) => goalLine(goal, tasks.filter((task) => {
    // Give the summary only the selected goal's tasks.
    return task.goalId === goal.id
  })))
  const pending = store.listApprovals('pending')
  const tail = pending.length ? ` ${count(pending.length, 'approval')} waiting: ${pending.map((approval) => {
    // Tell the user what each pending action is called, not internal ids.
    return approval.action
  }).join('; ')}.` : ''
  return `${count(goals.length, 'goal')} in progress. ${lines.join(' ')}${tail}`
}
