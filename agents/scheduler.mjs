import { MAX_WORKERS } from './config.mjs'
import { parseEvery } from './store.mjs'
import { createScheduledJobs } from './scheduled-jobs.mjs'

/**
 * The loop that turns queued tasks into running workers. No model: it picks
 * tasks whose dependencies are done and whose goal is active, highest priority
 * first, up to the cap, and records how each one ended before handing the goal
 * back to the coordinator.
 */

/** Identify provider capacity errors that should requeue without an attempt. */
export const isRateLimit = (err) => /rate.?limit|\b429\b|overloaded/i.test(String(err?.message ?? err))

/** Return active-goal tasks whose dependencies are complete, priority ordered. */
export function runnable(store, running) {
  const goals = new Map(store.listGoals().map((goal) => {
    // Resolve task goal ids to state and priority in constant time.
    return [goal.id, goal]
  }))
  const done = new Set(store.listTasks({ status: 'done' }).map((task) => {
    // Dependency checks need only the completed task ids.
    return task.id
  }))
  return store
    .listTasks({ status: 'queued' })
    .filter((task) => {
      // Skip duplicate runs, inactive goals, and tasks with unfinished dependencies.
      return !running.has(task.id) && goals.get(task.goalId)?.status === 'active' &&
        (task.dependsOn ?? []).every((dependency) => done.has(dependency))
    })
    .sort((first, second) => {
      // Prefer goal priority, then stable creation time and id ordering.
      return goals.get(first.goalId).priority - goals.get(second.goalId).priority ||
        first.created.localeCompare(second.created) || first.id.localeCompare(second.id)
    })
}

const EVENT = { done: 'task_done', failed: 'task_failed', blocked: 'task_blocked', cancelled: 'task_cancelled' }
const VERB = { done: 'Task complete', failed: 'Task failed', blocked: 'Task blocked', cancelled: 'Task cancelled' }
const cancelledOutcome = { status: 'cancelled', failure: { reason: 'cancelled', detail: 'Stopped by the user.' } }

/** Build the worker loop, recurring-job runner, and task lifecycle controls. */
export function createScheduler({
  store, runTask, coordinator,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  pool = null,
  maxWorkers = MAX_WORKERS,
  tickMs = 5000,
  retryDelayMs = 30_000,
  onCancel = () => {},
  onArchive = () => {},
  mirror = {},
}) {
  const schedules = createScheduledJobs({ store, coordinator, now, mirror })
  const running = new Map()
  const inflight = new Set()
  let backoffMs = 0
  let backoffUntil = 0
  let timer = null
  let unsubscribe = null
  let ticking = false
  let again = false

  /** Build user-facing event labels without exposing internal goal details. */
  const labels = (task) => ({ title: task.title, goalTitle: store.getGoal(task.goalId)?.title ?? '' })

  /** Persist a terminal task outcome, count its attempt, and append its event. */
  function finish(task, outcome) {
    const current = store.getTask(task.id) ?? task
    store.saveTask({
      ...current,
      status: outcome.status,
      result: outcome.result ?? null,
      failure: outcome.failure ?? null,
      attempts: current.attempts + 1,
      resume: false,
    })
    return store.appendEvent({
      type: EVENT[outcome.status],
      goalId: task.goalId,
      taskId: task.id,
      text: `${VERB[outcome.status]}: ${task.title}`,
      data: { ...labels(task), reason: outcome.failure?.reason ?? null },
    })
  }

  /** Run a worker with session persistence and one retry for transient failures. */
  async function execute(task, controller, endpoint) {
    /** Persist the Claude session id so a retry can resume the same work. */
    const onSession = (sessionId) => {
      const t = store.getTask(task.id)
      if (t) store.saveTask({ ...t, sessionId })
    }
    for (let tries = 0; ; tries++) {
      if (controller.signal.aborted) return cancelledOutcome
      try {
        return await runTask(task, { signal: controller.signal, onSession, endpoint })
      } catch (err) {
        if (endpoint?.kind !== 'remote' && isRateLimit(err)) throw err
        if (endpoint?.kind === 'remote' || tries >= 1) return { status: 'failed', failure: { reason: 'error', detail: String(err?.message ?? err) } }
        await sleep(retryDelayMs)
        if (controller.signal.aborted) return cancelledOutcome
      }
    }
  }

  /** Start a task, record runtime assignment, and release capacity on completion. */
  function launch(task, lease = null) {
    const controller = new AbortController()
    const endpoint = lease?.endpoint ?? null
    // Where this run went, so the board can show every agent's provider and model.
    const runtime = {
      endpointId: endpoint?.id ?? null,
      label: endpoint?.label ?? null,
      provider: task.execution?.provider ?? endpoint?.kind ?? 'anthropic',
      model: task.execution?.model ?? endpoint?.model ?? task.model ?? null,
      startedAt: new Date(now()).toISOString(),
    }
    const t = store.saveTask({ ...task, status: 'running', runtime })
    running.set(t.id, controller)
    store.appendEvent({
      type: 'task_started',
      goalId: t.goalId,
      taskId: t.id,
      text: `Started: ${t.title}`,
      data: { ...labels(t), endpoint: lease?.endpoint.id ?? null },
    })
    const promise = execute(t, controller, lease?.endpoint ?? null)
      // Save terminal outcomes and let the coordinator review completed work.
      .then(
        (outcome) => {
          running.delete(t.id)
          backoffMs = 0
          const ev = finish(t, outcome)
          if (outcome.status !== 'cancelled') return coordinator.review(t.goalId, ev)
        },
        // Return rate-limited work to the queue without counting a failed attempt.
        () => {
          running.delete(t.id)
          backoffMs = Math.min(Math.max(30_000, backoffMs * 2), 15 * 60_000)
          backoffUntil = now() + backoffMs
          const current = store.getTask(t.id) ?? t
          store.saveTask({ ...current, status: 'queued', resume: Boolean(current.sessionId) })
          store.appendEvent({
            type: 'task_queued',
            goalId: t.goalId,
            taskId: t.id,
            text: `Rate limited; ${t.title} will retry in ${Math.round(backoffMs / 1000)} seconds.`,
            data: labels(t),
          })
        },
      )
      // A review failure is logged but does not undo the worker's saved result.
      .catch((err) => console.warn('[agents] review failed:', err.message))
      .finally(() => {
        // Released here rather than beside the outcome, so a run that ends any
        // way at all — outcome, rate limit, thrown review — gives its capacity
        // back. A leaked lease would shrink the pool for the process's life.
        lease?.release()
        inflight.delete(promise)
        tick()
      })
    inflight.add(promise)
  }

  const FINISHED = ['done', 'failed', 'blocked', 'cancelled']
  const KEEP_RUNS = 3

  /**
   * A recurring goal would otherwise grow a task, a folder and a snapshot line
   * per run forever. Only the last few runs stay live; older ones are marked
   * archived — out of the cap, the snapshot and the board — and handed to
   * onArchive so their workspaces can go.
   */
  function archiveOldRuns(goalId) {
    const finished = store
      .listTasks({ goalId })
      .filter((task) => {
        // Keep only visible terminal runs eligible for recurring-history trimming.
        return !task.archived && FINISHED.includes(task.status)
      })
      .sort((first, second) => {
        // Archive the oldest completed runs first.
        return first.updated.localeCompare(second.updated) || first.id.localeCompare(second.id)
      })
    for (const t of finished.slice(0, Math.max(0, finished.length - KEEP_RUNS))) {
      const saved = store.saveTask({ ...t, archived: true })
      try {
        onArchive(saved)
      } catch (err) {
        console.warn(`[agents] could not archive ${t.id}: ${err.message}`)
      }
    }
  }

  /** Queue the next occurrence once a recurring goal has no active task. */
  function requeueGoal(goal) {
    const tasks = store.listTasks({ goalId: goal.id }).filter((task) => {
      // Archived executions do not represent the current recurring run.
      return !task.archived
    })
    if (!tasks.length || tasks.some((task) => {
      // Never overlap a recurring occurrence with work still in progress.
      return ['queued', 'running', 'awaiting_approval'].includes(task.status)
    })) return
    const last = tasks
      .filter((task) => {
        // Use the latest terminal result as the interval's reference point.
        return ['done', 'failed', 'blocked'].includes(task.status)
      })
      .sort((first, second) => first.updated.localeCompare(second.updated))
      .at(-1)
    if (!last || now() - Date.parse(last.updated) < parseEvery(goal.recurring.every)) return
    // A lost remote run retains its handle; retry the same run instead of
    // creating a new task and posting a second copy to the other host.
    if (last.remote) return
    const next = store.newTask({
      goalId: goal.id, title: last.title, brief: last.brief, kind: last.kind, model: last.model, repo: last.workspace?.repo ?? null,
    })
    store.appendEvent({ type: 'task_queued', goalId: goal.id, taskId: next.id, text: `Recurring run queued: ${next.title}`, data: labels(next) })
    archiveOldRuns(goal.id)
  }

  /** Check each active recurring goal independently and queue any due work. */
  function requeueRecurring() {
    for (const goal of store.listGoals()) {
      if (goal.status !== 'active' || !goal.recurring) continue
      // One goal with a hand-edited interval must not stop every other goal.
      try {
        requeueGoal(goal)
      } catch (err) {
        console.warn(`[agents] recurring goal ${goal.id} skipped: ${err.message}`)
      }
    }
  }

  /** Schedule due work while preventing overlapping scheduler passes. */
  function tick() {
    if (ticking) {
      again = true
      return
    }
    ticking = true
    try {
      do {
        again = false
        schedules.tick()
        if (now() < backoffUntil) break
        requeueRecurring()
        for (const task of runnable(store, running)) {
          if (running.size >= maxWorkers) break
          if (!pool) {
            launch(task)
            continue
          }
          const lease = pool.acquire(task)
          // No lease for this task may mean the pool is full, or only that the
          // endpoint it is pinned to is busy — in which case a later task can
          // still start.
          if (!lease) {
            if (!pool.free()) break
            continue
          }
          launch(task, lease)
        }
      } while (again)
    } catch (err) {
      // tick runs from a timer; an exception here would take the service down
      // and systemd would bring it back into the same state every few seconds.
      console.warn('[agents] scheduler tick failed:', err.message)
    } finally {
      ticking = false
    }
  }

  return {
    schedules,
    tick,
    /** Subscribe to store changes and start the periodic scheduling timer. */
    start() {
      unsubscribe = store.onEvent(() => tick())
      timer = setInterval(tick, tickMs)
      tick()
    },
    /** Stop the periodic timer and detach the store event listener. */
    stop() {
      clearInterval(timer)
      unsubscribe?.()
    },
    /** Return a snapshot of currently running task ids. */
    running: () => new Set(running.keys()),
    /** Abort active work or mark a queued/blocked task as cancelled. */
    cancel(taskId) {
      const controller = running.get(taskId)
      if (controller) {
        onCancel(taskId)
        controller.abort()
        return true
      }
      const t = store.getTask(taskId)
      if (!t || !['queued', 'blocked', 'failed'].includes(t.status)) return false
      onCancel(taskId)
      store.saveTask({ ...t, status: 'cancelled' })
      store.appendEvent({ type: 'task_cancelled', goalId: t.goalId, taskId, text: `Task cancelled: ${t.title}`, data: labels(t) })
      return true
    },
    /** Wait until scheduled planning and worker executions have settled. */
    async idle() {
      await schedules.idle()
      await Promise.all([...inflight])
    },
  }
}
