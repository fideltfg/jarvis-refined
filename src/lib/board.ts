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

/** Where an agent-service task was sent to run. */
export type AgentRuntime = {
  endpointId: string | null
  label: string | null
  provider: string
  model: string | null
  startedAt?: string | null
}

/** The agent service's board, as the bridge relays it. */
export type AgentTask = {
  id: string
  title: string
  kind: string
  status: 'queued' | 'running' | 'blocked' | 'awaiting_approval' | 'done' | 'failed' | 'cancelled'
  attempts: number
  summary: string | null
  awaitingResponse?: boolean
  created?: string
  updated?: string
  model?: string | null
  runtime?: AgentRuntime | null
  remote?: { endpointId: string } | null
  origin?: { label: string } | null
  questions?: AgentDecisionQuestion[]
  references?: AgentReference[]
  decisionRequired?: boolean
  failure?: { blocker?: string; questions?: AgentDecisionQuestion[] } | null
}
export type AgentDecisionQuestion = {
  id: string
  prompt: string
  options: { id: string; label: string; detail?: string; recommended?: boolean }[]
}
export type AgentReference = { title: string; url?: string; path?: string }
export type AgentGoal = {
  id: string
  title: string
  outcome: string
  notes?: string | null
  awaitingResponse?: boolean
  status: string
  priority: number
  tasks: AgentTask[]
  created?: string
  updated?: string
  profileId?: string
  profileSnapshot?: { id: string; name: string; role: string; instructions: string; skills?: string[]; version: string }
}
export type AgentApproval = { id: string; taskId: string; category: string; action: string; detail: string; created?: string }

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
  scheduleModels?: Partial<Record<'claude' | 'openai' | 'local', string[]>>
  schedules?: import('./schedules').Schedule[]
  goals: AgentGoal[]
  approvals: AgentApproval[]
  running: string[]
  /** Absent from an older agent service, which has no /endpoints route. */
  capacity?: AgentCapacity | null
}

/** Keep saved work visible while live snapshots remain authoritative. */
export function mergeBoardData(current: AgentBoardData | null, history: AgentBoardData | null): AgentBoardData | null {
  if (!history) return current
  if (!current) return history

  const liveGoals = new Map(current.goals.map((goal) => {
    // Index current goals so saved rows can be overlaid without losing history.
    return [goal.id, goal]
  }))
  const goals = history.goals.map((saved) => {
    const live = liveGoals.get(saved.id)
    if (!live) return saved
    liveGoals.delete(saved.id)
    const tasks = new Map(saved.tasks.map((task) => {
      // Seed with saved tasks, then overlay newer live snapshots below.
      return [task.id, task]
    }))
    for (const task of live.tasks) tasks.set(task.id, { ...tasks.get(task.id), ...task })
    return { ...saved, ...live, tasks: [...tasks.values()] }
  })
  goals.push(...liveGoals.values())
  return { ...history, ...current, goals }
}

/** An installed skill a profile may choose, as GET /skills reports it. */
export type InstalledSkill = { id: string; name: string; description: string }

export type AgentProfile = {
  id: string
  name: string
  role: string
  instructions: string
  /** Skill ids — their directory names, never paths. Empty on profiles saved before skills existed. */
  skills: string[]
  schedule: {
    trigger: import('./schedules').ScheduleTrigger
    priority: number
    execution?: import('./schedules').ScheduleExecution
  } | null
  scheduleId: string | null
  created: string
  updated: string
}

export type AgentProfileInput = Pick<AgentProfile, 'name' | 'role' | 'instructions'> & { skills?: string[]; schedule?: AgentProfile['schedule'] }
export type AgentProfileRequest =
  | { action: 'list' }
  | { action: 'skills' }
  | { action: 'create'; profile: AgentProfileInput }
  | { action: 'update'; profileId: string; changes: Partial<AgentProfileInput> }
  | { action: 'delete'; profileId: string }
  | { action: 'run'; profileId: string }

/** A Claude Code subagent spawned inside the voice session itself. */
export type SessionAgent = {
  id: string
  title: string
  /** The subagent type, e.g. 'Explore' or 'general-purpose'. */
  kind: string
  status: 'running' | 'done' | 'failed' | 'interrupted'
  startedAt: string
  finishedAt?: string | null
  summary: string | null
  /** The handle a background agent's completion notification names it by. */
  agentId?: string | null
  /** The conversation provider that dispatched it. */
  provider?: string | null
  model?: string | null
  /** The start of the instructions it was given. */
  brief?: string | null
  background?: boolean
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
  awaitingResponse: boolean
  /** Every row is JARVIS's, whichever provider carries it. */
  owner: 'JARVIS'
  /** Where it runs, in words: provider, endpoint or host. Null for goals. */
  runsOn: string | null
  model: string | null
  /** The goal a task serves, by name. */
  goal: string | null
  /** What it was asked to do, when that is more than its name. */
  brief: string | null
  questions?: AgentDecisionQuestion[]
  references?: AgentReference[]
  decisionRequired?: boolean
}

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: 'Anthropic',
  claude: 'Claude',
  openai: 'OpenAI',
  gateway: 'Gateway',
  local: 'Local',
  remote: 'Remote host',
}

/** Convert provider ids to labels suitable for board rows. */
const providerName = (provider: string | null | undefined) =>
  provider ? (PROVIDER_LABEL[provider] ?? provider) : null

/** Where an agent-service task runs, or would run, in one phrase. */
export function taskRunsOn(task: AgentTask): string | null {
  if (task.origin?.label) return `delegated by ${task.origin.label}`
  const runtime = task.runtime
  if (!runtime) return task.remote ? `${PROVIDER_LABEL.remote} · ${task.remote.endpointId}` : null
  const name = providerName(runtime.provider)
  const where = runtime.label ?? runtime.endpointId
  return where && where !== name ? `${name} · ${where}` : name
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

/** Return a short UI label, falling back to the status value for unknown states. */
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
  const down = capacity.endpoints.filter((endpoint) => {
    // Count unhealthy endpoints for the concise capacity summary.
    return !endpoint.healthy
  }).length
  const parts = [`${capacity.running} of ${capacity.capacity} busy`]
  if (capacity.endpoints.length > 1) parts.push(plural(capacity.endpoints.length, 'endpoint'))
  if (down) parts.push(`${down} down`)
  return parts.join(' · ')
}

/** Map persisted goal lifecycle values to the board's row status vocabulary. */
const goalStatus = (status: string): BoardAgentStatus => status === 'paused' ? 'paused' : status === 'done' ? 'done' : status === 'abandoned' ? 'cancelled' : 'active'

export type BoardStateGroup = 'waiting' | 'working' | 'paused' | 'idle'

/**
 * Which roster section a row belongs to. "Idle" is the one that matters beyond
 * layout: it is the board's definition of an agent that has stopped for good —
 * done, failed, cancelled or interrupted — and so the only one safe to erase.
 * Everything else is live in some way, including paused work, which is only
 * resting and still owns a workspace.
 */
export const stateGroup = (row: BoardAgent): BoardStateGroup =>
  row.status === 'blocked' || row.status === 'awaiting_approval' ? 'waiting'
    : row.status === 'paused' ? 'paused'
      : ['active', 'running', 'queued'].includes(row.status) ? 'working' : 'idle'

/**
 * Why this row cannot be deleted, in words the user can act on, or null when it
 * can. Deletion is only ever offered at goal granularity: a task's records go
 * with its goal, and a subagent has no stored record to remove at all. The
 * service re-checks all of this before erasing anything — this is the same rule
 * stated early, so the board never offers a button that is bound to fail.
 */
export function deleteBlockReason(row: BoardAgent | undefined | null): string | null {
  if (!row) return 'Select an agent first.'
  if (row.kind === 'subagent') return 'Session subagents keep no saved record; this one clears itself.'
  if (row.kind === 'task') return 'Tasks are removed with the agent they belong to, not on their own.'
  if (stateGroup(row) !== 'idle') return `“${row.name}” is still ${statusLabel(row.status)}. Stop it before deleting it.`
  return null
}

/** Agents doing work right now, whatever provider carries them. Goals are plans, not agents. */
export const runningAgents = (rows: BoardAgent[]): BoardAgent[] =>
  rows.filter((row) => row.kind !== 'goal' && row.status === 'running')

/** Keep goals plus tasks requiring direct attention in the main task view. */
export const mainTaskRows = (rows: BoardAgent[]): BoardAgent[] =>
  rows.filter((row) => row.kind === 'goal' || (row.kind === 'task' && (row.status === 'blocked' || row.approval !== null)))

/** The board's headline: how many of JARVIS's agents are in each live state. */
export function agentSummary(rows: BoardAgent[]): string {
  const agents = rows.filter((row) => row.kind !== 'goal')
  const parts = [`${runningAgents(rows).length} running`]
  const waiting = agents.filter((row) => row.status === 'awaiting_approval' || row.status === 'blocked').length
  const queued = agents.filter((row) => row.status === 'queued').length
  if (waiting) parts.push(`${waiting} waiting`)
  if (queued) parts.push(`${queued} queued`)
  return parts.join(' · ')
}

/** Format a numeric count with a simple singular/plural noun. */
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** The one-line "what is this goal doing" that replaces a static outcome. */
function goalActivity(live: AgentTask[], done: number): string {
  const parts = [`${done} of ${plural(live.length, 'task')} done`]
  for (const status of ['running', 'awaiting_approval', 'blocked', 'failed', 'queued'] as const) {
    const n = live.filter((task) => {
      // Count only tasks matching this row's activity state.
      return task.status === status
    }).length
    if (n) parts.push(`${n} ${statusLabel(status)}`)
  }
  return parts.join(' · ')
}

/** Describe task kind and surface its retry number only after a retry. */
function taskActivity(task: AgentTask): string {
  // Attempts only mean something once something has gone wrong the first time.
  return task.attempts > 1 ? `${task.kind} · attempt ${task.attempts}` : task.kind
}

/** Identify statuses that count as ended for display timestamps. */
const terminal = (status: BoardAgentStatus) => URGENCY[status] >= URGENCY.failed

/** A stamp to sort by: when it ended if it has, else when it started. */
/** Select an ending timestamp or, for active rows, their start timestamp. */
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
export function mergeBoard(board: AgentBoardData | null, session: SessionAgent[] = [], { history = false } = {}): BoardAgent[] {
  const units: BoardAgent[][] = []

  for (const goal of board?.goals ?? []) {
    const live = goal.tasks.filter((task) => {
      // Cancelled tasks do not contribute to progress or the visible live row list.
      return task.status !== 'cancelled'
    })
    const done = live.filter((task) => {
      // Progress counts only completed tasks.
      return task.status === 'done'
    }).length
    const goalRow: BoardAgent = {
      id: goal.id,
      kind: 'goal',
      name: goal.title,
      status: goalStatus(goal.status),
      activity: goalActivity(live, done),
      result: goal.notes?.trim() || null,
      startedAt: goal.created ?? null,
      finishedAt: null,
      parentId: null,
      progress: live.length ? done / live.length : 0,
      approval: null,
      awaitingResponse: goal.awaitingResponse ?? false,
      owner: 'JARVIS',
      runsOn: null,
      model: null,
      goal: null,
      brief: goal.outcome || null,
    }
    const tasks: BoardAgent[] = (history ? goal.tasks : live).map((task) => ({
      id: task.id,
      kind: 'task',
      name: task.title,
      status: task.status,
      activity: taskActivity(task),
      result: task.summary,
      startedAt: task.runtime?.startedAt ?? task.created ?? null,
      finishedAt: terminal(task.status) ? (task.updated ?? null) : null,
      parentId: goal.id,
      progress: null,
      approval: board?.approvals.find((approval) => {
        // Attach only the approval that belongs to this task.
        return approval.taskId === task.id
      }) ?? null,
      awaitingResponse: task.awaitingResponse ?? false,
      owner: 'JARVIS',
      runsOn: taskRunsOn(task),
      model: task.runtime?.model ?? task.model ?? null,
      goal: goal.title,
      brief: null,
      questions: task.questions ?? task.failure?.questions ?? [],
      references: task.references ?? [],
      decisionRequired: task.failure?.blocker === 'decision',
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
        activity: agent.background ? `${agent.kind} · background` : agent.kind,
        result: agent.summary,
        startedAt: agent.startedAt,
        finishedAt: agent.finishedAt ?? null,
        parentId: null,
        progress: null,
        approval: null,
        awaitingResponse: false,
        owner: 'JARVIS',
        runsOn: `${providerName(agent.provider ?? 'claude')} session`,
        model: agent.model ?? null,
        goal: null,
        brief: agent.brief ?? null,
      },
    ])
  }

  /** Rank a goal/task unit by its most urgent row. */
  const rank = (unit: BoardAgent[]) => Math.min(...unit.map((row) => URGENCY[row.status]))
  /** Find the latest timestamp in a unit for tie-breaking. */
  const recency = (unit: BoardAgent[]) => unit.reduce((newest, row) => (at(row) > newest ? at(row) : newest), '')

  return units
    .map((unit, index) => {
      // Retain the original index so equal urgency/recency remains stable.
      return { unit, index }
    })
    .sort(
      (a, b) =>
        rank(a.unit) - rank(b.unit) ||
        recency(b.unit).localeCompare(recency(a.unit)) ||
        // Stable, so a board that has not changed does not reshuffle itself.
        a.index - b.index,
    )
    // Flatten each sorted goal/task group without separating its children.
    .flatMap((entry) => entry.unit)
}
