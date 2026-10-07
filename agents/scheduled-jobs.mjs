import { newId } from './store.mjs'
import { nextRun, scheduleInput, scheduleChangesSchema } from './schedules.mjs'

export function createScheduledJobs({ store, coordinator, now = Date.now, mirror = {} }) {
  const planning = new Map()
  const emit = (schedule, text) => store.appendEvent({
    type: 'schedule_changed', goalId: schedule.lastGoalId, text,
    data: { scheduleId: schedule.id, title: schedule.title },
  })
  const busy = (schedule) => {
    const goal = schedule.lastGoalId && store.getGoal(schedule.lastGoalId)
    return Boolean(goal && !['done', 'abandoned'].includes(goal.status))
  }

  function plan(schedule) {
    const occurrence = schedule.pendingOccurrence
    if (!occurrence || planning.has(schedule.id) || (occurrence.retryAt && Date.parse(occurrence.retryAt) > now())) return
    let goal = store.getGoal(occurrence.goalId)
    if (!goal) {
      goal = store.newGoal({
        id: occurrence.goalId, title: schedule.title, outcome: schedule.outcome,
        priority: schedule.priority, scheduleId: schedule.id, occurrenceKey: occurrence.key,
        execution: schedule.execution,
      })
      mirror.goalCreated?.(goal)
    }
    const current = store.getSchedule(schedule.id)
    store.saveSchedule({ ...current, lastGoalId: goal.id, lastRunAt: occurrence.startedAt })
    if (store.listTasks({ goalId: goal.id }).length || goal.status !== 'active') {
      store.saveSchedule({ ...store.getSchedule(schedule.id), pendingOccurrence: null })
      emit(store.getSchedule(schedule.id), `Recovered scheduled run: ${schedule.title}`)
      return
    }
    const promise = Promise.resolve().then(() => coordinator.plan(goal.id)).then(() => {
      const saved = store.getSchedule(schedule.id)
      store.saveSchedule({ ...saved, pendingOccurrence: null, error: null })
      emit(saved, `Scheduled run planned: ${schedule.title}`)
    }).catch((err) => {
      const saved = store.getSchedule(schedule.id)
      const attempts = (occurrence.attempts ?? 0) + 1
      const hasTasks = store.listTasks({ goalId: goal.id }).length > 0
      const exhausted = attempts >= 3
      if (exhausted && !hasTasks) store.saveGoal({ ...store.getGoal(goal.id), status: 'abandoned' })
      store.saveSchedule({
        ...saved, error: String(err.message ?? err),
        status: exhausted && !hasTasks && saved.status !== 'deleted' ? 'paused' : saved.status,
        pendingOccurrence: hasTasks || exhausted ? null : {
          ...occurrence, attempts, retryAt: new Date(now() + attempts * 60000).toISOString(),
        },
      })
      emit(saved, `Scheduled planning failed: ${schedule.title}: ${err.message}`)
    }).finally(() => planning.delete(schedule.id))
    planning.set(schedule.id, promise)
    emit(store.getSchedule(schedule.id), `Scheduled run started: ${schedule.title}`)
  }

  function launch(schedule, manual = false) {
    if (schedule.pendingOccurrence || busy(schedule)) throw new Error('The previous scheduled run is still active. Resolve it on the agent board first.')
    const startedAt = new Date(now()).toISOString()
    const dueAt = manual ? startedAt : schedule.nextRunAt
    const saved = store.saveSchedule({
      ...schedule,
      status: schedule.trigger.type === 'once' ? 'completed' : schedule.status,
      nextRunAt: schedule.trigger.type === 'once' ? null : manual ? schedule.nextRunAt : nextRun(schedule.trigger, now(), dueAt),
      pendingOccurrence: { key: `${schedule.id}:${dueAt}`, goalId: newId('g'), startedAt, attempts: 0 },
      error: null,
    })
    plan(saved)
    return store.getSchedule(schedule.id)
  }

  return {
    tick() {
      for (const schedule of store.listSchedules()) {
        try {
          if (schedule.pendingOccurrence) { plan(schedule); continue }
          if (schedule.status === 'active' && schedule.nextRunAt && Date.parse(schedule.nextRunAt) <= now() && !busy(schedule)) launch(schedule)
        } catch (err) {
          console.warn(`[agents] schedule ${schedule.id} skipped: ${err.message}`)
        }
      }
    },
    create(input) {
      const saved = store.newSchedule(input)
      emit(saved, `Schedule created: ${saved.title}`)
      return saved
    },
    update(id, change) {
      const schedule = store.getSchedule(id)
      if (!schedule || schedule.status === 'deleted') throw new Error('Schedule not found.')
      if (!change || typeof change !== 'object') throw new Error('A schedule change is required.')
      let saved
      if (change.action === 'edit') {
        const values = scheduleChangesSchema.parse(change.values)
        if (schedule.pendingOccurrence) throw new Error('Wait for the current run to finish planning before editing.')
        const next = change.values.trigger ? scheduleInput({
          title: values.title ?? schedule.title, outcome: values.outcome ?? schedule.outcome,
          priority: values.priority ?? schedule.priority, trigger: values.trigger,
          execution: values.execution ?? schedule.execution,
        }, now()) : values
        saved = store.saveSchedule({ ...schedule, ...next, status: schedule.status === 'completed' && values.trigger ? 'active' : schedule.status })
      } else if (['pause', 'resume', 'delete'].includes(change.action)) {
        if (change.action !== 'delete' && schedule.status === 'completed') throw new Error('This one-time schedule has completed. Edit its time to schedule another run.')
        saved = store.saveSchedule({ ...schedule, status: { pause: 'paused', resume: 'active', delete: 'deleted' }[change.action] })
      } else throw new Error('Use edit, pause, resume or delete.')
      emit(saved, `Schedule ${change.action}: ${saved.title}`)
      return saved
    },
    runNow(id) {
      const schedule = store.getSchedule(id)
      if (!schedule || !['active', 'paused'].includes(schedule.status)) throw new Error('No runnable schedule found.')
      return launch(schedule, true)
    },
    async idle() { await Promise.all([...planning.values()]) },
  }
}