/**
 * One shape for every kind of agent, and the merge that produces it.
 *
 * Two sources feed the board and they have nothing in common structurally. The
 * agent service (jarvis_agents) reports goals, each holding tasks and any
 * approval a task is waiting on; it persists across sessions and survives a
 * reload. The voice session reports subagents — Claude Code `Task` tool calls
 * dispatched inside a turn, which have no goal above them, no approvals below
 * them, and usually die within the minute they were born.
 *
 * Presenting those as two lists made "what are your agents doing" two questions
 * with two answers. So both are normalised onto `BoardAgent` and merged into a
 * single list here, leaving the board to render rows rather than reconcile
 * sources.
 *
 * Self-contained on purpose: node --test loads it directly by stripping types,
 * so it must not import anything.
 */

/** The agent service's board, as the bridge relays it. */
export type AgentTask = {
  id: string
  title: string
  kind: string
  status: 'queued' | 'running' | 'blocked' | 'awaiting_approval' | 'done' | 'failed' | 'cancelled'
  attempts: number
  summary: string | null
  created?: string
  updated?: string
}
export type AgentGoal = {
  id: string
  title: string
  outcome: string
  status: string
  priority: number
  tasks: AgentTask[]
  created?: string
  updated?: string
}
export type AgentApproval = { id: string; taskId: string; category: string; action: string; detail: string }

/** One model endpoint an agent task can run on, as GET /endpoints reports it. */
export type AgentEndpoint = {
  id: string
  label: string
  kind: string
  model: string | null
  healthy: boolean
  running: number
  concurrency: number
  kinds: string[]
}
/** The pool: how wide it is, how much of it is busy, and where. */
export type AgentCapacity = { capacity: number | null; running: number; endpoints: AgentEndpoint[] }

export type AgentBoardData = {
  goals: AgentGoal[]
  approvals: AgentApproval[]
  running: string[]
  /** Absent from an older agent service, which has no /endpoints route. */
  capacity?: AgentCapacity | null
}

/** A Claude Code subagent spawned inside the voice session itself. */
export type SessionAgent = {
  id: string
  title: string
  /** The subagent type, e.g. 'Explore' or 'general-purpose'. */
  kind: string
  status: 'running' | 'done' | 'failed' | 'interrupted'
  startedAt: string
  finishedAt?: string
  summary: string | null
}

/** Which source a row came from. Shown on the row, never used to split the list. */
export type BoardAgentKind = 'goal' | 'task' | 'subagent'

export type BoardAgentStatus =
  | 'awaiting_approval'
  | 'blocked'
  | 'running'
  | 'queued'
  | 'active'
  | 'paused'
  | 'failed'
  | 'interrupted'
  | 'done'
  | 'cancelled'

/** One agent on the board, whatever kind of agent it happens to be. */
export type BoardAgent = {
  id: string
  kind: BoardAgentKind
  /** What to call it: a goal's title, a task's title, a subagent's brief. */
  name: string
  status: BoardAgentStatus
  /** What it is doing, in one line. */
  activity: string
  /** What came of it — a result summary or a failure detail — or null. */
  result: string | null
  startedAt: string | null
  finishedAt: string | null
  /** The goal a task belongs to. Null for goals and subagents. */
  parentId: string | null
  /** Goals only: the fraction of live tasks finished, 0 to 1. */
  progress: number | null
  /** The approval this row is waiting on, if any. */
  approval: AgentApproval | null
}

/**
 * How much a row wants the user's attention. Lower comes first, and it is the
 * only thing the sort really cares about: a blocked task the user can unblock
 * matters more than eight subagents that finished cleanly.
 */
const URGENCY: Record<BoardAgentStatus, number> = {
  awaiting_approval: 0,
  blocked: 1,
  running: 2,
  queued: 3,
  active: 4,
  paused: 5,
  failed: 6,
  interrupted: 7,
  done: 8,
  cancelled: 9,
}

const STATUS_LABEL: Record<BoardAgentStatus, string> = {
  awaiting_approval: 'approval',
  blocked: 'blocked',
  running: 'running',
  queued: 'queued',
  active: 'active',
  paused: 'paused',
  failed: 'failed',
  interrupted: 'interrupted',
  done: 'done',
  cancelled: 'cancelled',
}

export const statusLabel = (status: BoardAgentStatus): string => STATUS_LABEL[status] ?? status

/**
 * How long ago, in as few characters as a row can spare.
 *
 * The board now outlives the session that filled it, so "done" on its own stops
 * meaning anything: the user cannot tell this morning's finished agent from one
 * that finished a week ago. Anything under a minute reads as "now" rather than
 * a jittering second count.
 */
export function ago(stamp: string | null, now: number = Date.now()): string | null {
  if (!stamp) return null
  const then = Date.parse(stamp)
  if (Number.isNaN(then)) return null
  const secs = Math.max(0, Math.round((now - then) / 1000))
  if (secs < 60) return 'now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/**
 * The pool in one line: how much of the capacity is in use, and nothing else.
 *
 * A single endpoint is the ordinary case and says nothing worth a line of its
 * own, so it is left out; the per-endpoint detail is drawn as chips beside it.
 */
export function capacityLine(capacity: AgentCapacity | null | undefined): string | null {
  if (!capacity || capacity.capacity === null) return null
  if (capacity.endpoints.length < 2 && capacity.running === 0) return null
  const down = capacity.endpoints.filter((e) => !e.healthy).length
  const parts = [`${capacity.running} of ${capacity.capacity} busy`]
  if (capacity.endpoints.length > 1) parts.push(plural(capacity.endpoints.length, 'endpoint'))
  if (down) parts.push(`${down} down`)
  return parts.join(' · ')
}

const goalStatus = (status: string): BoardAgentStatus => (status === 'paused' ? 'paused' : 'active')

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** The one-line "what is this goal doing" that replaces a static outcome. */
function goalActivity(live: AgentTask[], done: number): string {
  const parts = [`${done} of ${plural(live.length, 'task')} done`]
  for (const status of ['running', 'awaiting_approval', 'blocked', 'failed', 'queued'] as const) {
    const n = live.filter((t) => t.status === status).length
    if (n) parts.push(`${n} ${statusLabel(status)}`)
  }
  return parts.join(' · ')
}

function taskActivity(task: AgentTask): string {
  // Attempts only mean something once something has gone wrong the first time.
  return task.attempts > 1 ? `${task.kind} · attempt ${task.attempts}` : task.kind
}

const terminal = (status: BoardAgentStatus) => URGENCY[status] >= URGENCY.failed

/** A stamp to sort by: when it ended if it has, else when it started. */
const at = (row: BoardAgent) => row.finishedAt ?? row.startedAt ?? ''

/**
 * Merge both sources into one list.
 *
 * Rows are grouped into units so a goal never drifts away from its own tasks —
 * a goal plus its tasks is one unit, a subagent is a unit of one — and units
 * are ordered by the most urgent row inside them, most recent first within a
 * tie. Tasks keep their goal's order rather than being re-sorted, because a
 * plan read out of order is not a plan.
 */
export function mergeBoard(board: AgentBoardData | null, session: SessionAgent[] = []): BoardAgent[] {
  const units: BoardAgent[][] = []

  for (const goal of board?.goals ?? []) {
    const live = goal.tasks.filter((t) => t.status !== 'cancelled')
    const done = live.filter((t) => t.status === 'done').length
    const goalRow: BoardAgent = {
      id: goal.id,
      kind: 'goal',
      name: goal.title,
      status: goalStatus(goal.status),
      activity: goalActivity(live, done),
      result: null,
      startedAt: goal.created ?? null,
      finishedAt: null,
      parentId: null,
      progress: live.length ? done / live.length : 0,
      approval: null,
    }
    const tasks: BoardAgent[] = live.map((task) => ({
      id: task.id,
      kind: 'task',
      name: task.title,
      status: task.status,
      activity: taskActivity(task),
      result: task.summary,
      startedAt: task.created ?? null,
      finishedAt: terminal(task.status) ? (task.updated ?? null) : null,
      parentId: goal.id,
      progress: null,
      approval: board?.approvals.find((a) => a.taskId === task.id) ?? null,
    }))
    units.push([goalRow, ...tasks])
  }

  for (const agent of session) {
    units.push([
      {
        id: agent.id,
        kind: 'subagent',
        name: agent.title,
        status: agent.status,
        // A subagent's type is the closest thing it has to a job description,
        // and it is the only hint of what kind of work is being done.
        activity: agent.kind,
        result: agent.summary,
        startedAt: agent.startedAt,
        finishedAt: agent.finishedAt ?? null,
        parentId: null,
        progress: null,
        approval: null,
      },
    ])
  }

  const rank = (unit: BoardAgent[]) => Math.min(...unit.map((r) => URGENCY[r.status]))
  const recency = (unit: BoardAgent[]) => unit.reduce((newest, r) => (at(r) > newest ? at(r) : newest), '')

  return units
    .map((unit, index) => ({ unit, index }))
    .sort(
      (a, b) =>
        rank(a.unit) - rank(b.unit) ||
        recency(b.unit).localeCompare(recency(a.unit)) ||
        // Stable, so a board that has not changed does not reshuffle itself.
        a.index - b.index,
    )
    .flatMap((entry) => entry.unit)
}
