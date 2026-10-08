import http from 'node:http'
import https from 'node:https'
import { isLoopback, TRAVELLING_KINDS } from '../bridge/endpoints.mjs'
import { listInstalledSkills, unknownSkills } from '../bridge/skills.mjs'
import { boardOf, briefing } from './briefing.mjs'
import { BUDGETS } from './config.mjs'
import { profileChanges, profileInput, profileOutcome } from './profiles.mjs'
import { scheduleInput } from './schedules.mjs'
import { readTaskReference, taskReports } from './reports.mjs'
import { removeWorkspace } from './workspace.mjs'
import { rmSync } from 'node:fs'

/**
 * The agent service's only door: HTTP with a bearer token, plus an SSE stream
 * of events for the bridge.
 *
 * It binds to loopback unless it is given TLS, because the token is as good as
 * the user's own hands on this machine and the obvious way to reach it from
 * another host — an SSH tunnel — lands on loopback anyway. That rule is checked
 * here rather than written in the documentation: the service will not start
 * open and unencrypted.
 */

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 1_000_000) {
        reject(new Error('Body too large.'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })

class NotFound extends Error {}

/** Goal states that are over, and so safe to erase. */
const ERASABLE = ['done', 'abandoned']

export function createApi({ store, scheduler, coordinator, approvals, cleanup, mirror = {}, pool = null, installedSkills = listInstalledSkills, token, host = '127.0.0.1', port = 0, tls = null }) {
  if (!token) throw new Error('JARVIS_AGENTS_TOKEN is not set; refusing to start an unauthenticated API.')
  if (!isLoopback(host) && !tls) {
    throw new Error(
      `JARVIS_AGENTS_HOST is ${host}, which is not loopback. A service other machines can reach must present TLS ` +
      '(JARVIS_AGENTS_TLS_CERT and JARVIS_AGENTS_TLS_KEY), or stay on 127.0.0.1 behind an SSH tunnel.',
    )
  }

  const clients = new Set()
  const off = store.onEvent((ev) => {
    for (const res of clients) res.write(`data: ${JSON.stringify(ev)}\n\n`)
  })
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n')
  }, 25_000)
  const warn = (err) => console.warn('[agents]', err.message)

  function changeGoal(goal, body) {
    const event = (action) =>
      store.appendEvent({ type: 'goal_changed', goalId: goal.id, text: `${goal.title}: ${action}`, data: { title: goal.title, action } })
    if (typeof body.info === 'string' && body.action !== 'resume') {
      event('updated')
      coordinator.redirect(goal.id, body.info).catch(warn)
      return goal
    }
    if (body.action === 'pause') {
      const g = store.saveGoal({ ...goal, status: 'paused' })
      event('paused')
      return g
    }
    if (body.action === 'resume') {
      const g = store.saveGoal({ ...goal, status: 'active' })
      event('resumed')
      coordinator.redirect(g.id, typeof body.info === 'string' && body.info.trim()
        ? body.info : 'The user resumed this goal. Continue.').catch(warn)
      return g
    }
    if (body.action === 'abandon') {
      for (const t of store.listTasks({ goalId: goal.id })) {
        if (['queued', 'running', 'awaiting_approval', 'blocked'].includes(t.status)) scheduler.cancel(t.id)
      }
      const g = store.saveGoal({ ...goal, status: 'abandoned' })
      event('abandoned')
      return g
    }
    throw new Error('A change must be pause, resume, abandon, or info.')
  }

  /**
   * Erase a finished goal and everything it produced — records, approvals,
   * workspaces and saved reports. There is no undo, so the guard is strict:
   * only a goal that has stopped, and only when none of its tasks is still in
   * flight. Live work is paused or abandoned first, deliberately, by hand.
   */
  function eraseGoal(goal) {
    if (!ERASABLE.includes(goal.status)) {
      throw new Error(`“${goal.title}” is still ${goal.status}. Stop it before erasing it.`)
    }
    const tasks = store.listTasks({ goalId: goal.id })
    const running = scheduler.running()
    const busy = tasks.find((task) => ['running', 'awaiting_approval'].includes(task.status) || running.has(task.id))
    if (busy) throw new Error(`“${busy.title}” is still ${busy.status}. Erasing would leave it orphaned.`)
    for (const task of tasks) {
      try {
        removeWorkspace(task)
      } catch (err) {
        warn(new Error(`could not remove ${task.workspace?.path}: ${err.message}`))
      }
    }
    rmSync(store.goalOutputDir(goal.id), { recursive: true, force: true })
    const removed = store.deleteGoal(goal.id)
    if (!removed) throw new NotFound(`No goal ${goal.id}.`)
    store.appendEvent({
      type: 'goal_deleted',
      goalId: goal.id,
      text: `Erased: ${goal.title}`,
      data: { title: goal.title, tasks: removed.tasks.length },
    })
    return { id: goal.id, deleted: true, tasks: removed.tasks.length }
  }

  /**
   * Delegated work needs a goal to hang from — the scheduler only runs tasks
   * whose goal is active — but it is not a goal this machine is thinking about.
   * One per origin host, marked delegated so the coordinator leaves it alone:
   * the host that sent the work is the one reasoning about what comes next.
   */
  function delegatedGoal(label) {
    const title = `Delegated work from ${label}`
    const existing = store.listGoals().find((g) => g.delegated && g.title === title)
    if (existing) return existing.status === 'active' ? existing : store.saveGoal({ ...existing, status: 'active' })
    const goal = store.saveGoal({
      ...store.newGoal({
        title,
        outcome: `Run the tasks ${label} sends, and report each result back to it.`,
        priority: 2,
        taskCap: Number.MAX_SAFE_INTEGER,
      }),
      delegated: true,
    })
    store.appendEvent({ type: 'goal_created', goalId: goal.id, text: `New goal: ${goal.title}`, data: { title: goal.title } })
    return goal
  }

  /**
   * The sender's budget, but never above this machine's own ceiling for that
   * kind of work. Another host may ask for less time and less money; it does
   * not get to ask for more.
   */
  const clampBudget = (kind, budget = {}) => {
    const cap = BUDGETS[kind]
    const least = (asked, limit) => Math.min(Number(asked) > 0 ? Number(asked) : limit, limit)
    return {
      maxTurns: least(budget.maxTurns, cap.maxTurns),
      maxMinutes: least(budget.maxMinutes, cap.maxMinutes),
      maxUsd: least(budget.maxUsd, cap.maxUsd),
    }
  }

  function acceptTask(body) {
    if (!TRAVELLING_KINDS.includes(body.kind)) {
      throw new Error(
        `A delegated task must be one of ${TRAVELLING_KINDS.join(', ')}; got "${body.kind ?? ''}". ` +
        'Code stays on the machine that owns the repository, and admin work stays where the browser is signed in.',
      )
    }
    const label = String(body.origin?.label ?? 'another host').slice(0, 60)
    const goal = delegatedGoal(label)
    // The agent here sees the local delegated goal, which says nothing about
    // why the work matters. The sender's goal is put in the brief instead, as
    // context rather than as instructions.
    const context = body.origin?.goalTitle
      ? `\n\nThis task was sent by ${label}, toward its goal: ${body.origin.goalTitle}` +
        `${body.origin.goalOutcome ? ` — done means: ${body.origin.goalOutcome}` : ''}.`
      : ''
    const task = store.newTask({
      goalId: goal.id,
      title: body.title,
      brief: `${body.brief ?? ''}${context}`,
      kind: body.kind,
      model: body.model || 'sonnet',
      allowedSkills: Array.isArray(body.allowedSkills) ? body.allowedSkills : [],
    })
    const saved = store.saveTask({
      ...task,
      budget: clampBudget(body.kind, body.budget),
      delegated: true,
      origin: { label, taskId: body.origin?.taskId ?? null },
    })
    store.appendEvent({
      type: 'task_queued',
      goalId: goal.id,
      taskId: saved.id,
      text: `Accepted from ${label}: ${saved.title}`,
      data: { title: saved.title, goalTitle: goal.title },
    })
    return { id: saved.id, goalId: goal.id }
  }

  const scheduleForProfile = (profile, schedule) => ({
    title: profile.name,
    outcome: `Use the latest instructions from agent profile ${profile.id}.`,
    profileId: profile.id,
    trigger: schedule.trigger,
    priority: schedule.priority,
    ...(schedule.execution && { execution: schedule.execution }),
  })

  /**
   * A name the picker never offered is a mistake worth refusing. A name the
   * profile already carries is not: skills come and go on disk under the
   * user's hands, and a profile must stay editable after one of them goes.
   */
  function checkSkills(skills, kept = []) {
    if (!skills?.length) return
    const missing = unknownSkills(skills, { installed: installedSkills() }).filter((id) => !kept.includes(id))
    if (missing.length) {
      throw new Error(`No installed skill named ${missing.join(', ')}. Choose from the installed skills, or install it first.`)
    }
  }

  function createProfile(body) {
    const input = profileInput.parse(body)
    checkSkills(input.skills)
    if (input.schedule) scheduleInput(scheduleForProfile({ ...input, id: 'p_validation' }, input.schedule), new Date())
    let profile = store.newProfile({ ...input, schedule: input.schedule ?? null })
    try {
      if (profile.schedule) {
        const schedule = scheduler.schedules.create(scheduleForProfile(profile, profile.schedule))
        profile = store.saveProfile({ ...profile, scheduleId: schedule.id })
      }
    } catch (err) {
      store.deleteProfile(profile.id)
      throw err
    }
    store.appendEvent({ type: 'profile_created', text: `Agent profile created: ${profile.name}`, data: { profileId: profile.id, title: profile.name } })
    return profile
  }

  function updateProfile(id, body) {
    const current = store.getProfile(id)
    if (!current) throw new NotFound('Agent profile not found.')
    const changes = profileChanges.parse(body)
    if (Object.hasOwn(changes, 'skills')) checkSkills(changes.skills, current.skills ?? [])
    const next = { ...current, ...changes, schedule: Object.hasOwn(changes, 'schedule') ? changes.schedule : current.schedule }
    const profileFieldsChanged = ['name', 'role', 'instructions'].some((key) => Object.hasOwn(changes, key))
    const scheduleChanged = Object.hasOwn(changes, 'schedule') && JSON.stringify(next.schedule) !== JSON.stringify(current.schedule)
    if (next.schedule) scheduleInput(scheduleForProfile(next, next.schedule), new Date())
    let scheduleId = current.scheduleId ?? null
    if (current.scheduleId && !next.schedule) {
      const schedule = store.getSchedule(current.scheduleId)
      if (schedule && schedule.status !== 'deleted') scheduler.schedules.update(schedule.id, { action: 'delete' })
      scheduleId = null
    } else if (next.schedule && scheduleId) {
      const schedule = store.getSchedule(scheduleId)
      if (!schedule || schedule.status === 'deleted') scheduleId = null
      else if (profileFieldsChanged || scheduleChanged) {
        const { profileId: linkedProfileId, ...values } = scheduleForProfile(next, next.schedule)
        void linkedProfileId
        if (!scheduleChanged) delete values.trigger
        scheduler.schedules.update(scheduleId, { action: 'edit', values })
      }
    }
    if (next.schedule && !scheduleId) {
      const schedule = scheduler.schedules.create(scheduleForProfile(next, next.schedule))
      scheduleId = schedule.id
    }
    const saved = store.saveProfile({ ...next, scheduleId })
    store.appendEvent({ type: 'profile_changed', text: `Agent profile updated: ${saved.name}`, data: { profileId: saved.id, title: saved.name } })
    return saved
  }

  function deleteProfile(id) {
    const profile = store.getProfile(id)
    if (!profile) throw new NotFound('Agent profile not found.')
    if (profile.scheduleId) {
      const schedule = store.getSchedule(profile.scheduleId)
      if (schedule && schedule.status !== 'deleted') scheduler.schedules.update(schedule.id, { action: 'delete' })
    }
    store.deleteProfile(id)
    store.appendEvent({ type: 'profile_deleted', text: `Agent profile deleted: ${profile.name}`, data: { profileId: id, title: profile.name } })
    return { id, deleted: true }
  }

  function runProfile(id) {
    const profile = store.getProfile(id)
    if (!profile) throw new NotFound('Agent profile not found.')
    const goal = store.newGoal({
      title: profile.name,
      outcome: profileOutcome(profile),
      priority: profile.schedule?.priority ?? 3,
      execution: profile.schedule?.execution,
      profileId: profile.id,
      profileSnapshot: { id: profile.id, name: profile.name, role: profile.role, instructions: profile.instructions, version: profile.updated },
    })
    store.appendEvent({ type: 'goal_created', goalId: goal.id, text: `New goal from agent profile: ${goal.title}`, data: { title: goal.title, profileId: profile.id } })
    mirror.goalCreated?.(goal)
    coordinator.plan(goal.id).catch(warn)
    return goal
  }

  /** How a delegated task is watched from the host that sent it. */
  function taskState(id, since) {
    const task = store.getTask(id)
    if (!task) throw new NotFound(`No task ${id}.`)
    const progress = store.readEvents({ limit: 5000 }).filter((e) => e.taskId === id && e.type === 'task_progress')
    return {
      id,
      status: task.status,
      result: task.result ?? null,
      failure: task.failure ?? null,
      events: progress.slice(Math.max(0, since)).map((e) => ({ at: e.at, text: e.text })),
      eventCount: progress.length,
    }
  }

  const handler = async (req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'unauthorised' })

    const url = new URL(req.url, 'http://x')
    const [head, id, tail] = url.pathname.split('/').filter(Boolean)
    const route = `${req.method} /${[head, id && ':id', tail].filter(Boolean).join('/')}`

    if (route === 'GET /events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write(': connected\n\n')
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }

    let body = {}
    if (req.method === 'POST') {
      try {
        body = JSON.parse((await readBody(req)) || '{}')
      } catch {
        return send(400, { error: 'The body must be JSON.' })
      }
    }

    try {
      switch (route) {
        case 'GET /board':
          return send(200, boardOf(store, scheduler.running(), { history: url.searchParams.get('history') === '1' }))
        // Where the capacity is, and how much of it is busy. Endpoint ids and
        // labels only: no base URLs and no keys leave the process.
        case 'GET /endpoints':
          return send(200, pool
            ? { capacity: pool.capacity(), running: pool.inFlight(), endpoints: pool.snapshot() }
            : { capacity: null, running: scheduler.running().size, endpoints: [] })
        case 'GET /status':
          return send(200, { text: briefing(store, url.searchParams.get('goal') || undefined) })
        case 'GET /schedules':
          return send(200, store.listSchedules().filter((schedule) => schedule.status !== 'deleted'))
        // What a profile may choose from. Names and descriptions only: the
        // directory each skill came from stays on this machine.
        case 'GET /skills':
          return send(200, installedSkills().map(({ id: skillId, name, description }) => ({ id: skillId, name, description })))
        case 'GET /profiles':
          return send(200, store.listProfiles())
        case 'POST /profiles':
          return send(201, createProfile(body))
        case 'POST /profiles/:id':
          if (body.action === 'delete') return send(200, deleteProfile(id))
          return send(200, updateProfile(id, body))
        case 'POST /profiles/:id/run':
          return send(201, runProfile(id))
        case 'POST /schedules':
          return send(201, scheduler.schedules.create(body))
        case 'POST /schedules/:id':
          if (!store.getSchedule(id) || store.getSchedule(id).status === 'deleted') throw new NotFound('Schedule not found.')
          return send(200, scheduler.schedules.update(id, body))
        case 'POST /schedules/:id/run':
          if (!store.getSchedule(id)) throw new NotFound('Schedule not found.')
          return send(200, scheduler.schedules.runNow(id))
        case 'POST /goals': {
          const { title, outcome, priority, recurring, taskCap } = body
          const goal = store.newGoal({ title, outcome, priority, recurring, taskCap })
          store.appendEvent({ type: 'goal_created', goalId: goal.id, text: `New goal: ${goal.title}`, data: { title: goal.title } })
          mirror.goalCreated?.(goal)
          coordinator.plan(goal.id).catch(warn)
          return send(201, goal)
        }
        case 'POST /goals/:id': {
          const goal = store.getGoal(id)
          if (!goal) throw new NotFound(`No goal ${id}.`)
          if (body.action === 'erase') return send(200, eraseGoal(goal))
          return send(200, changeGoal(goal, body))
        }
        // Work sent by another host running a remote agent runtime. It is queued
        // here like any other task and gated here like any other task: the
        // sender chooses what to ask for, this machine chooses what is allowed.
        case 'POST /tasks':
          return send(201, acceptTask(body))
        case 'GET /tasks/:id':
          return send(200, taskState(id, Number(url.searchParams.get('since')) || 0))
        case 'GET /tasks/:id/reports': {
          const task = store.getTask(id)
          if (!task) throw new NotFound(`No task ${id}.`)
          return send(200, await taskReports(task, url.searchParams.get('file')))
        }
        case 'GET /tasks/:id/reference': {
          const task = store.getTask(id)
          if (!task) throw new NotFound(`No task ${id}.`)
          const asked = url.searchParams.get('index') ?? ''
          if (!/^(0|[1-9]\\d{0,2})$/.test(asked)) throw new Error('Invalid document reference.')
          return send(200, await readTaskReference(task, Number(asked)))
        }
        case 'POST /tasks/:id/cancel':
          if (!scheduler.cancel(id)) throw new NotFound(`No cancellable task ${id}.`)
          return send(200, { ok: true })
        case 'GET /approvals':
          return send(200, store.listApprovals('pending'))
        case 'POST /approvals/:id':
          return send(200, approvals.decide(id, body.decision, body.note ?? null))
        case 'POST /cleanup':
          return send(200, { removed: cleanup() })
        default:
          return send(404, { error: 'not found' })
      }
    } catch (err) {
      return send(err instanceof NotFound ? 404 : 400, { error: err.message })
    }
  }

  // One handler, two doors. The guard above has already decided that a door
  // onto the network must be the TLS one, so this choice cannot be the thing
  // that leaves the token in the open.
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler)

  return {
    tls: Boolean(tls),
    listen: () => new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port))),
    close() {
      off()
      clearInterval(heartbeat)
      for (const res of clients) res.end()
      clients.clear()
      server.closeAllConnections?.()
      return new Promise((resolve) => server.close(resolve))
    },
  }
}
