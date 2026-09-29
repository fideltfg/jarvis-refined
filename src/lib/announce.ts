/**
 * Short spoken updates about agent work.
 *
 * Only endings, blockers and approvals are worth interrupting the room for;
 * routine progress stays on the board. Updates wait until JARVIS is idle —
 * never over the user or another answer — and a burst arriving together is
 * merged into one line. Phrasing is templated per theme rather than generated,
 * so it costs nothing and can never ramble.
 *
 * Self-contained on purpose: node --test loads it directly by stripping types,
 * and a relative import without an extension would stop that working.
 */

export type AgentEvent = {
  at: string
  type: string
  goalId?: string
  taskId?: string
  text: string
  data?: Record<string, unknown>
}

const SPOKEN = new Set(['task_done', 'task_failed', 'task_blocked', 'goal_done', 'goal_paused', 'approval_needed'])

export const spoken = (e: AgentEvent): boolean => SPOKEN.has(e.type)

const field = (e: AgentEvent, key: string): string => String(e.data?.[key] ?? e.text)

const ONE_STARK: Record<string, (e: AgentEvent) => string> = {
  task_done: (e) => `${field(e, 'title')} is finished.`,
  task_failed: (e) => `${field(e, 'title')} has failed.`,
  task_blocked: (e) => `${field(e, 'title')} is stuck and needs you.`,
  goal_done: (e) => `Goal achieved: ${field(e, 'title')}.`,
  goal_paused: (e) => `${field(e, 'title')} is paused and needs your attention.`,
  approval_needed: (e) => `An agent needs your approval to ${field(e, 'action')}.`,
}

const ONE_TERSE: Record<string, (e: AgentEvent) => string> = {
  task_done: (e) => `Task complete: ${field(e, 'title')}.`,
  task_failed: (e) => `Task failed: ${field(e, 'title')}.`,
  task_blocked: (e) => `Task blocked: ${field(e, 'title')}. Input required.`,
  goal_done: (e) => `Goal complete: ${field(e, 'title')}.`,
  goal_paused: (e) => `Goal suspended: ${field(e, 'title')}. Input required.`,
  approval_needed: (e) => `Authorisation required: ${field(e, 'action')}.`,
}

const MANY_STARK: Record<string, (n: number) => string> = {
  task_done: (n) => `${n} tasks are finished.`,
  task_failed: (n) => `${n} tasks have failed.`,
  task_blocked: (n) => `${n} tasks are stuck and need you.`,
  goal_done: (n) => `${n} goals are complete.`,
  goal_paused: (n) => `${n} goals are paused and need you.`,
  approval_needed: (n) => `${n} approvals are waiting for you.`,
}

const MANY_TERSE: Record<string, (n: number) => string> = {
  task_done: (n) => `${n} tasks complete.`,
  task_failed: (n) => `${n} tasks failed.`,
  task_blocked: (n) => `${n} tasks blocked. Input required.`,
  goal_done: (n) => `${n} goals complete.`,
  goal_paused: (n) => `${n} goals suspended. Input required.`,
  approval_needed: (n) => `${n} authorisations required.`,
}

export function phrase(events: AgentEvent[], theme: string): string {
  const stark = theme === 'stark'
  const one = stark ? ONE_STARK : ONE_TERSE
  const many = stark ? MANY_STARK : MANY_TERSE
  const groups = new Map<string, AgentEvent[]>()
  for (const e of events.filter(spoken)) groups.set(e.type, [...(groups.get(e.type) ?? []), e])
  // Approvals last: they are the part that asks something of the listener.
  const order = [...groups.keys()].sort((a, b) => Number(a === 'approval_needed') - Number(b === 'approval_needed'))
  return order
    .map((type) => {
      const list = groups.get(type) ?? []
      return list.length === 1 ? one[type](list[0]) : many[type](list.length)
    })
    .join(' ')
}

export function createAnnouncer(opts: {
  say: (text: string) => Promise<void>
  idle: () => boolean
  theme: string
  mergeMs?: number
  retryMs?: number
  schedule?: (fn: () => void, ms: number) => unknown
}) {
  const mergeMs = opts.mergeMs ?? 3000
  const retryMs = opts.retryMs ?? 2000
  const schedule = opts.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  let buffer: AgentEvent[] = []
  let armed = false
  let speaking = false

  const arm = (ms: number) => {
    if (armed) return
    armed = true
    schedule(() => void flush(), ms)
  }

  async function flush(): Promise<void> {
    armed = false
    if (!buffer.length || speaking) return
    if (!opts.idle()) {
      arm(retryMs)
      return
    }
    const batch = buffer
    buffer = []
    speaking = true
    try {
      await opts.say(phrase(batch, opts.theme))
    } finally {
      speaking = false
      if (buffer.length) arm(mergeMs)
    }
  }

  return {
    push(e: AgentEvent) {
      if (!spoken(e)) return
      buffer.push(e)
      arm(mergeMs)
    },
    flush,
  }
}
