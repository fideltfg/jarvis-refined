/**
 * Subagents spawned inside the voice session, so the board shows every kind of
 * agent in one place.
 *
 * The agent service (jarvis_agents) has its own goals and tasks and reports
 * them over its event feed. A Claude Code subagent is a different animal: it
 * exists only as a `Task` tool call inside a turn, nothing else ever hears
 * about it, and without this it would work and finish invisibly while the board
 * claimed nothing was happening.
 *
 * Feed it from the whole `assistant` message rather than the partial stream: a
 * tool_use block's input arrives as input_json_delta fragments and is only
 * complete there, which is where the description and subagent type live.
 *
 * The list is also written to disk, because the alternative is amnesia: the
 * agent service survives a restart and its goals come back, so a board that
 * forgot every subagent the moment the bridge died told the user a half-truth
 * the next morning — and JARVIS, reading the same board, would cheerfully start
 * a second copy of work he had already dispatched. A subagent restored from
 * disk while still marked running cannot actually be running, since the process
 * that owned it is gone, so it comes back as `interrupted` rather than being
 * quietly resurrected as live.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * The tool that dispatches a subagent is named `Task` on some Claude Code
 * builds and `Agent` on others. Matching only one of them is indistinguishable
 * from the feature being broken: the board simply stays empty.
 */
export const SESSION_AGENT_TOOLS = ['Task', 'Agent']

/** True for a tool_use block that dispatches a subagent, on any build. */
export const isSessionAgentTool = (name) => SESSION_AGENT_TOOLS.includes(name)

const SESSION_AGENT_LIMIT = 8
const SESSION_AGENT_DELAY = 120
const SUMMARY_LIMIT = 160
const BRIEF_LIMIT = 240

/** How many past subagents the file keeps, and for how long. */
const HISTORY_LIMIT = 40
const HISTORY_DAYS = 14

/** Where the history lives, beside the rest of the JARVIS state. */
export const sessionAgentsFile = () =>
  process.env.JARVIS_SESSION_AGENTS_FILE ||
  join(homedir(), '.config', 'jarvis', 'session-agents.json')

const stamp = (agent) => agent.finishedAt || agent.startedAt || ''

/** Records worth keeping: recent, capped, and never more than HISTORY_LIMIT. */
const prune = (agents, cutoff) =>
  agents
    .filter((a) => a && typeof a.id === 'string' && stamp(a) >= cutoff)
    .sort((a, b) => (stamp(a) < stamp(b) ? 1 : -1))
    .slice(0, HISTORY_LIMIT)
    .reverse()

/**
 * Read the history back.
 *
 * A missing or corrupt file is not an error worth failing a session over — the
 * board simply starts empty, which is where it used to start every time.
 */
export function loadSessionAgents(file, now = () => new Date().toISOString()) {
  if (!file) return []
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
  const agents = Array.isArray(parsed) ? parsed : parsed?.agents
  if (!Array.isArray(agents)) return []
  const cutoff = new Date(Date.parse(now()) - HISTORY_DAYS * 864e5).toISOString()
  return prune(agents, cutoff).map((agent) =>
    // Nothing from a previous process can still be running.
    agent.status === 'running' ? { ...agent, status: 'interrupted', finishedAt: agent.finishedAt ?? null } : agent,
  )
}

/** A tool_result's content is a string on some builds and blocks on others. */
const resultText = (content) => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join(' ')
}

const trimmed = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '')

/**
 * A background dispatch returns the moment the agent is launched, not when it
 * finishes. Settling on that acknowledgement is how the board came to show a
 * twenty-minute research run as `done` four seconds after it started — the one
 * state it was certainly not in. Recognise the acknowledgement and keep the row
 * running until something actually reports back.
 */
const LAUNCH_ACK = /launched successfully|running in the background/i

/** The handle a later notification will refer to the agent by. */
const AGENT_ID = /agentId:\s*([A-Za-z0-9_-]+)/

/**
 * The internal id is explicitly not for the user, and the raw acknowledgement is
 * nothing but internal ids and file paths. Never let it become a row's summary.
 */
const launchSummary = () => 'dispatched · working in the background'

/**
 * A finished background agent is announced as a `<task-notification>` block in
 * the next turn rather than as a tool result, so it arrives keyed by agentId
 * with no tool_use id anywhere near it. Parse what it says.
 */
export function parseTaskNotification(text) {
  if (typeof text !== 'string' || !text.includes('<task-notification>')) return null
  const field = (name) => text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim() ?? ''
  const agentId = field('task-id')
  if (!agentId) return null
  return { agentId, status: field('status'), summary: field('summary') }
}

/** The notification's own word for how it ended, in the board's vocabulary. */
const notifiedStatus = (status) => {
  const value = String(status || '').toLowerCase()
  if (value === 'completed' || value === 'done' || value === 'success') return 'done'
  if (value === 'failed' || value === 'error') return 'failed'
  return 'interrupted'
}

/**
 * Track the session's subagents and report the whole list whenever it changes.
 *
 * @param send   receives one `session_agents` frame per change
 * @param now    the clock, so tests can pin it
 * @param delay  how long to coalesce changes for, in milliseconds
 * @param limit  how many finished subagents to remember
 */
export function createSessionAgents({
  send,
  now = () => new Date().toISOString(),
  delay = SESSION_AGENT_DELAY,
  limit = SESSION_AGENT_LIMIT,
  file = sessionAgentsFile(),
} = {}) {
  const agents = new Map()
  const owned = new Set()
  // Which connection's Claude session is carrying each running agent.
  const carriers = new Map()
  let timer = null

  // Everything the last process saw, so the board opens with a memory.
  for (const agent of loadSessionAgents(file, now)) agents.set(agent.id, agent)

  const save = () => {
    if (!file) return
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify({ agents: [...agents.values()] }, null, 1), { mode: 0o600 })
      // Atomic: a crash mid-write must not leave a truncated file behind.
      renameSync(tmp, file)
    } catch {
      // History is a convenience. Losing it must never take the session with it.
    }
  }

  /**
   * What the board is shown: everything still live, plus the most recent few
   * that are not. The file remembers far more than a screen should display, so
   * a fortnight of history does not push today's work off the bottom.
   */
  const visible = () => {
    const all = [...agents.values()]
    const live = all.filter((a) => a.status === 'running')
    const past = all.filter((a) => a.status !== 'running').slice(-limit)
    return [...past, ...live]
  }

  const push = () => {
    clearTimeout(timer)
    // Coalesced: a fan-out of four subagents is one frame, not four.
    timer = setTimeout(() => {
      timer = null
      save()
      send({ type: 'session_agents', agents: visible() })
    }, delay)
  }

  return {
    snapshot: () => [...agents.values()].map((agent) => ({ ...agent, live: owned.has(agent.id) })),
    /** Report the current list without waiting for a change. */
    resend: push,

    /** A `Task` tool_use block: a subagent has just been dispatched. */
    start(id, input, { provider = 'claude', model = null, carrier = null } = {}) {
      if (!id || agents.has(id)) return
      owned.add(id)
      if (carrier) carriers.set(id, carrier)
      agents.set(id, {
        id,
        title: trimmed(input?.description) || 'subagent',
        kind: trimmed(input?.subagent_type) || 'general-purpose',
        status: 'running',
        startedAt: now(),
        summary: null,
        // Filled in from the launch acknowledgement, and the only handle a
        // later task notification will name it by.
        agentId: null,
        provider,
        model: trimmed(input?.model) || model,
        brief: trimmed(input?.prompt).slice(0, BRIEF_LIMIT) || null,
        background: input?.run_in_background === true,
      })
      // Finished agents are history; it is kept, but not without bound. Running
      // ones are never dropped — they are the live view.
      for (const [key, agent] of agents) {
        if (agents.size <= HISTORY_LIMIT) break
        if (agent.status !== 'running') agents.delete(key)
      }
      push()
    },

    /** The matching tool_result: the subagent has returned, or it has failed. */
    settle(id, failed, content) {
      const agent = agents.get(id)
      if (!agent) return
      const text = resultText(content).replace(/\s+/g, ' ').trim()

      // A background dispatch acknowledges the launch and returns at once. The
      // agent is still running; only a later notification can end it.
      if (!failed && LAUNCH_ACK.test(text)) {
        agent.agentId = text.match(AGENT_ID)?.[1] ?? agent.agentId ?? null
        agent.summary = launchSummary()
        push()
        return
      }

      agent.status = failed ? 'failed' : 'done'
      agent.finishedAt = now()
      agent.summary = text ? text.slice(0, SUMMARY_LIMIT) : null
      push()
    },

    /**
     * A `<task-notification>` for a background agent: it finished, failed or
     * was stopped. Keyed by agentId, because by now the tool_use id that
     * started it is several turns behind.
     */
    notify(agentId, status, summary) {
      if (!agentId) return
      const agent = [...agents.values()].find((a) => a.agentId === agentId || a.id === agentId)
      if (!agent) return
      owned.add(agent.id)
      agent.status = notifiedStatus(status)
      agent.finishedAt = now()
      const text = trimmed(summary).replace(/\s+/g, ' ')
      if (text) agent.summary = text.slice(0, SUMMARY_LIMIT)
      push()
    },

    /**
     * A stopped agent sent a message is resumed from its transcript rather than
     * started afresh, so the row that already exists goes back to running
     * instead of a second row appearing beside it.
     */
    resume(agentId, carrier = null) {
      if (!agentId) return
      const agent = [...agents.values()].find((a) => a.agentId === agentId || a.id === agentId)
      if (!agent || agent.status === 'running') return
      owned.add(agent.id)
      if (carrier) carriers.set(agent.id, carrier)
      agent.status = 'running'
      agent.finishedAt = null
      agent.summary = 'resumed · working in the background'
      push()
    },

    /**
     * A connection's Claude session has closed, taking its subagents with it.
     * Anything it was still carrying can no longer report back.
     */
    release(carrier) {
      if (!carrier) return
      let changed = false
      for (const [id, owner] of carriers) {
        if (owner !== carrier) continue
        carriers.delete(id)
        const agent = agents.get(id)
        if (agent?.status !== 'running') continue
        agent.status = 'interrupted'
        agent.finishedAt = now()
        agent.summary = 'session closed before the agent reported back'
        changed = true
      }
      if (changed) push()
    },

    /** Everything tracked, oldest first. */
    list() {
      return [...agents.values()]
    },

    /** The socket has closed; no further frame is wanted. */
    stop() {
      clearTimeout(timer)
      timer = null
    },
  }
}
