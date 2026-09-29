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
 */

export const SESSION_AGENT_TOOL = 'Task'

const SESSION_AGENT_LIMIT = 8
const SESSION_AGENT_DELAY = 120
const SUMMARY_LIMIT = 160

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
} = {}) {
  const agents = new Map()
  let timer = null

  const push = () => {
    clearTimeout(timer)
    // Coalesced: a fan-out of four subagents is one frame, not four.
    timer = setTimeout(() => {
      timer = null
      send({ type: 'session_agents', agents: [...agents.values()] })
    }, delay)
  }

  return {
    /** A `Task` tool_use block: a subagent has just been dispatched. */
    start(id, input) {
      if (!id || agents.has(id)) return
      agents.set(id, {
        id,
        title: trimmed(input?.description) || 'subagent',
        kind: trimmed(input?.subagent_type) || 'general-purpose',
        status: 'running',
        startedAt: now(),
        summary: null,
      })
      // Finished agents are history; a long session must not accumulate them
      // for ever. Running ones are never dropped — they are the live view.
      for (const [key, agent] of agents) {
        if (agents.size <= limit) break
        if (agent.status !== 'running') agents.delete(key)
      }
      push()
    },

    /** The matching tool_result: the subagent has returned, or it has failed. */
    settle(id, failed, content) {
      const agent = agents.get(id)
      if (!agent) return
      agent.status = failed ? 'failed' : 'done'
      agent.finishedAt = now()
      const text = resultText(content).replace(/\s+/g, ' ').trim()
      agent.summary = text ? text.slice(0, SUMMARY_LIMIT) : null
      push()
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
