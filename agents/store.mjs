import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { BUDGETS, DEFAULT_TASK_CAP, KINDS, WORK_DIR } from './config.mjs'
import { isTaskModel } from './pool.mjs'
import { scheduleInput } from './schedules.mjs'

/**
 * The agent service's state: one JSON file per goal, task and approval, plus an
 * append-only event log. Plain files so the user can read and fix them by hand,
 * the same bargain as the PA memory. A file that no longer parses is skipped
 * with a warning rather than taking the service down.
 */

/** Time, then a per-process sequence, then noise — so ids sort in creation order. */
let seq = 0
export const newId = (prefix) =>
  `${prefix}_${Date.now().toString(36)}${(seq++ % 1296).toString(36).padStart(2, '0')}${randomBytes(3).toString('hex')}`

export const slug = (text) =>
  String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task'

const UNITS = { m: 60_000, h: 3_600_000, d: 86_400_000 }

/** '30m', '6h', '1d' -> milliseconds. */
export function parseEvery(every) {
  const m = String(every).trim().match(/^(\d+)\s*([mhd])$/i)
  if (!m || Number(m[1]) <= 0) {
    throw new Error(`Cannot read the interval "${every}"; use a form like 30m, 6h or 1d.`)
  }
  return Number(m[1]) * UNITS[m[2].toLowerCase()]
}

function writeAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  renameSync(tmp, file)
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    console.warn(`[agents] skipping unreadable ${file}: ${err.message}`)
    return null
  }
}

export function createStore(root, { workDir = WORK_DIR, now = () => new Date() } = {}) {
  const dirs = {
    goals: join(root, 'goals'),
    tasks: join(root, 'tasks'),
    approvals: join(root, 'approvals'),
    schedules: join(root, 'schedules'),
    profiles: join(root, 'profiles'),
  }
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
  const eventsFile = join(root, 'events.jsonl')
  const listeners = new Set()
  const stamp = () => now().toISOString()

  const list = (kind) =>
    readdirSync(dirs[kind])
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJson(join(dirs[kind], f)))
      .filter((v) => v && typeof v.id === 'string')

  const get = (kind, id) => {
    const file = join(dirs[kind], `${id}.json`)
    return existsSync(file) ? readJson(file) : null
  }

  const save = (kind, value) => {
    const next = { ...value, updated: stamp() }
    writeAtomic(join(dirs[kind], `${value.id}.json`), next)
    return next
  }

  return {
    root,
    listGoals: () => list('goals'),
    getGoal: (id) => get('goals', id),
    saveGoal: (goal) => save('goals', goal),
    listTasks: (filter = {}) =>
      list('tasks').filter((t) => Object.entries(filter).every(([k, v]) => t[k] === v)),
    getTask: (id) => get('tasks', id),
    saveTask: (task) => save('tasks', task),
    listApprovals: (status) => list('approvals').filter((a) => !status || a.status === status),
    getApproval: (id) => get('approvals', id),
    saveApproval: (approval) => save('approvals', approval),

    listSchedules: () => list('schedules'),
    getSchedule: (id) => get('schedules', id),
    saveSchedule: (schedule) => save('schedules', schedule),
    listProfiles: () => list('profiles'),
    getProfile: (id) => get('profiles', id),
    saveProfile: (profile) => save('profiles', profile),
    deleteProfile(id) {
      const path = join(dirs.profiles, `${id}.json`)
      if (!existsSync(path)) return false
      unlinkSync(path)
      return true
    },
    newProfile({ name, role, instructions, id = newId('p'), schedule = null, scheduleId = null }) {
      if (!String(name ?? '').trim() || !String(role ?? '').trim() || !String(instructions ?? '').trim()) {
        throw new Error('An agent profile needs a name, role and instructions.')
      }
      if (!/^p_[a-z0-9]+$/.test(id) || get('profiles', id)) throw new Error('Invalid or existing agent profile id.')
      return save('profiles', {
        id,
        name: String(name).trim(),
        role: String(role).trim(),
        instructions: String(instructions).trim(),
        schedule,
        scheduleId,
        created: stamp(),
      })
    },
    newSchedule(input) {
      return save('schedules', {
        ...scheduleInput(input, now()), id: newId('s'), status: 'active',
        lastRunAt: null, lastGoalId: null, pendingOccurrence: null, error: null, created: stamp(),
      })
    },

    newGoal({ title, outcome, priority = 3, recurring = null, taskCap = DEFAULT_TASK_CAP, id = newId('g'), scheduleId, occurrenceKey, execution, profileId, profileSnapshot }) {
      if (!title || !outcome) throw new Error('A goal needs a title and an outcome.')
      if (!/^g_[a-z0-9]+$/.test(id) || get('goals', id)) throw new Error('Invalid or existing goal id.')
      if (recurring?.every) parseEvery(recurring.every)
      return save('goals', {
        id,
        ...(scheduleId ? { scheduleId, occurrenceKey } : {}),
        ...(execution ? { execution: { ...execution } } : {}),
        ...(profileId ? { profileId, profileSnapshot: { ...profileSnapshot } } : {}),
        title: String(title),
        outcome: String(outcome),
        status: 'active',
        priority: Math.min(5, Math.max(1, Math.round(Number(priority) || 3))),
        recurring: recurring?.every ? { every: String(recurring.every) } : null,
        taskCap,
        notes: '',
        created: stamp(),
      })
    },

    newTask({ goalId, title, brief, kind = 'research', dependsOn = [], model = 'sonnet', repo = null, allowedSkills = [] }) {
      if (!KINDS.includes(kind)) throw new Error(`Unknown task kind "${kind}".`)
      const id = newId('t')
      const path = join(workDir, 'goals', goalId, 'tasks', id)
      const execution = get('goals', goalId)?.execution
      const workspace =
        kind === 'code' && repo
          ? { path, repo, branch: `jarvis/${slug(title)}-${id.slice(-4)}` }
          : { path }
      return save('tasks', {
        id,
        goalId,
        title: String(title),
        brief: String(brief),
        kind,
        status: 'queued',
        dependsOn: [...dependsOn],
        workspace,
        // A size, or the id of a declared endpoint; anything else falls back
        // rather than pinning the task to a machine that does not exist.
        model: execution?.model ?? (isTaskModel(model) ? model : 'sonnet'),
        ...(execution ? { execution: { ...execution } } : {}),
        allowedSkills: kind === 'research' ? [...allowedSkills] : [],
        budget: { ...BUDGETS[kind] },
        attempts: 0,
        result: null,
        failure: null,
        sessionId: null,
        resume: false,
        created: stamp(),
      })
    },

    newApproval({ taskId, category, action, detail, recipients = [] }) {
      return save('approvals', {
        id: newId('a'),
        taskId,
        category,
        action,
        detail,
        recipients,
        status: 'pending',
        note: null,
        created: stamp(),
        decided: null,
      })
    },

    appendEvent(ev) {
      const event = { at: stamp(), ...ev }
      appendFileSync(eventsFile, JSON.stringify(event) + '\n')
      for (const fn of listeners) {
        try {
          fn(event)
        } catch (err) {
          console.warn('[agents] event listener failed:', err.message)
        }
      }
      return event
    },

    readEvents({ limit = 200 } = {}) {
      if (!existsSync(eventsFile)) return []
      return readFileSync(eventsFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .slice(-limit)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)]
          } catch {
            return []
          }
        })
    },

    onEvent(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}
