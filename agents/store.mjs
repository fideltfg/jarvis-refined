import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { normalizeSkills } from '../bridge/skills.mjs'
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

/** Convert a title into a short filesystem- and branch-friendly name. */
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

/** Replace one JSON record through a temporary file to avoid partial writes. */
function writeAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  renameSync(tmp, file)
}

/** Read a JSON record, warning and returning null when it is missing or corrupt. */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    console.warn(`[agents] skipping unreadable ${file}: ${err.message}`)
    return null
  }
}

/** Fields a profile file may predate, defaulted on read so no caller has to. */
const readProfile = (profile) => ({ ...profile, skills: normalizeSkills(profile.skills) })
/** Create the file-backed API for goals, tasks, schedules, approvals, and events. */
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

  /** Load all parseable JSON entities from one state directory. */
  const list = (kind) =>
    readdirSync(dirs[kind])
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJson(join(dirs[kind], f)))
      .filter((v) => v && typeof v.id === 'string')

  /** Load one entity by id, returning null when its record is absent. */
  const get = (kind, id) => {
    const file = join(dirs[kind], `${id}.json`)
    return existsSync(file) ? readJson(file) : null
  }

  /** Add an update timestamp and atomically persist one entity. */
  const save = (kind, value) => {
    const next = { ...value, updated: stamp() }
    writeAtomic(join(dirs[kind], `${value.id}.json`), next)
    return next
  }

  return {
    root,
    /** List all persisted goals. */
    listGoals: () => list('goals'),
    /** Load one goal record by id. */
    getGoal: (id) => get('goals', id),
    /** Persist a goal and refresh its update timestamp. */
    saveGoal: (goal) => save('goals', goal),
    /** List tasks matching every supplied top-level field. */
    listTasks: (filter = {}) =>
      list('tasks').filter((t) => Object.entries(filter).every(([k, v]) => t[k] === v)),
    /** Load one task record by id. */
    getTask: (id) => get('tasks', id),
    /** Persist a task and refresh its update timestamp. */
    saveTask: (task) => save('tasks', task),
    /** List approvals, optionally restricted to one lifecycle status. */
    listApprovals: (status) => list('approvals').filter((a) => !status || a.status === status),
    /** Load one approval record by id. */
    getApproval: (id) => get('approvals', id),
    /** Persist an approval record or decision. */
    saveApproval: (approval) => save('approvals', approval),

    /** List all saved schedules. */
    listSchedules: () => list('schedules'),
    /** Load one schedule record by id. */
    getSchedule: (id) => get('schedules', id),
    /** Persist a schedule and refresh its update timestamp. */
    saveSchedule: (schedule) => save('schedules', schedule),
    // There is no migration step for these files, so the shape a reader needs
    // is filled in on the way out: a profile saved before skills existed reads
    // back with an empty selection rather than an absent field.
    /** List all reusable agent profiles, normalizing older records. */
    listProfiles: () => list('profiles').map(readProfile),
    /** Load one profile record by id, normalizing older records. */
    getProfile: (id) => {
      const profile = get('profiles', id)
      return profile && readProfile(profile)
    },
    /** Persist a reusable profile with normalized skill identifiers. */
    saveProfile: (profile) => save('profiles', { ...profile, skills: normalizeSkills(profile.skills) }),
    /** Remove one profile record, returning whether it existed. */
    deleteProfile(id) {
      const path = join(dirs.profiles, `${id}.json`)
      if (!existsSync(path)) return false
      unlinkSync(path)
      return true
    },
    /** Validate and persist a profile with complete instructions. */
    newProfile({ name, role, instructions, skills = [], id = newId('p'), schedule = null, scheduleId = null }) {
      if (!String(name ?? '').trim() || !String(role ?? '').trim() || !String(instructions ?? '').trim()) {
        throw new Error('An agent profile needs a name, role and instructions.')
      }
      if (!/^p_[a-z0-9]+$/.test(id) || get('profiles', id)) throw new Error('Invalid or existing agent profile id.')
      return save('profiles', {
        id,
        name: String(name).trim(),
        role: String(role).trim(),
        instructions: String(instructions).trim(),
        skills: normalizeSkills(skills),
        schedule,
        scheduleId,
        created: stamp(),
      })
    },
    /** Validate and initialize an active schedule without a prior occurrence. */
    newSchedule(input) {
      return save('schedules', {
        ...scheduleInput(input, now()), id: newId('s'), status: 'active',
        lastRunAt: null, lastGoalId: null, pendingOccurrence: null, error: null, created: stamp(),
      })
    },

    /** Validate and persist a goal with normalized priority and recurrence. */
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

    /** Where a goal's tasks keep their workspaces and saved output. */
    goalOutputDir: (goalId) => join(workDir, 'goals', goalId),

    /**
     * Erase a finished goal: its record, its tasks and their approvals. The
     * caller removes the workspaces first, because a code task's worktree has
     * to be released through git rather than unlinked. Returns what went, so
     * the caller can say so; null when the goal is already gone.
     */
    deleteGoal(id) {
      const goal = get('goals', id)
      if (!goal) return null
      const tasks = list('tasks').filter((task) => task.goalId === id)
      const taskIds = new Set(tasks.map((task) => task.id))
      const approvals = list('approvals').filter((approval) => taskIds.has(approval.taskId))
      for (const approval of approvals) unlinkSync(join(dirs.approvals, `${approval.id}.json`))
      for (const task of tasks) unlinkSync(join(dirs.tasks, `${task.id}.json`))
      unlinkSync(join(dirs.goals, `${id}.json`))
      return { goal, tasks, approvals: approvals.length }
    },

    /** Validate and initialize a queued task with its workspace and budget. */
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

    /** Create a pending approval record for a policy-gated action. */
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

    /** Append an event durably and notify the current in-process listeners. */
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

    /** Read the newest valid event records, skipping malformed JSON lines. */
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

    /** Subscribe to appended events and return an unsubscribe callback. */
    onEvent(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}
