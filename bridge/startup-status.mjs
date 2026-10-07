export async function collectStartupStatus({ api, readMemory, readLooseEnds, readSessionAgents }) {
  const errors = []
  const read = async (source, operation) => {
    try {
      return await operation()
    } catch (error) {
      errors.push({ source, message: String(error.message ?? error) })
      return null
    }
  }
  const unavailable = () => { throw new Error('Background agents are disabled or not configured.') }
  const [board, schedules, capacity, memory, looseEnds, sessionAgents] = await Promise.all([
    read('background agents', api ? () => api.board({ history: true }) : unavailable),
    read('scheduled work', api ? () => api.schedules() : unavailable),
    read('remote endpoints', api ? () => api.endpoints() : unavailable),
    read('personal tasks', readMemory),
    read('unfinished work', readLooseEnds),
    read('session subagents', readSessionAgents),
  ])
  return { observedAt: new Date().toISOString(), board, schedules, capacity, memory, looseEnds, sessionAgents, errors }
}

export function mergeSessionAgents(snapshots) {
  const records = new Map()
  for (const agents of snapshots) {
    for (const agent of agents) {
      const previous = records.get(agent.id)
      const stamp = (record) => record.finishedAt || record.startedAt || ''
      if (!previous || (agent.live && !previous.live) ||
          (Boolean(agent.live) === Boolean(previous.live) && stamp(agent) >= stamp(previous))) {
        records.set(agent.id, agent)
      }
    }
  }
  return [...records.values()]
}

export async function handleStartupStatusRequest(message, dependencies, send) {
  if (message.type !== 'startup_status') return false
  if (typeof message.requestId !== 'string' || !message.requestId || message.requestId.length > 100) return true
  const snapshot = await collectStartupStatus(dependencies)
  send({ type: 'startup_status_reply', requestId: message.requestId, snapshot })
  return true
}