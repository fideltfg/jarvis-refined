import { z } from 'zod'

const request = z.object({
  goalId: z.string().regex(/^g_[a-z0-9]+$/).max(100),
  info: z.string().trim().min(1).max(10000),
  resume: z.boolean(),
})

export async function handleGoalRequest(message, api, send) {
  if (message.type !== 'goal_request') return false
  if (typeof message.requestId !== 'string' || !message.requestId || message.requestId.length > 100) return true
  const reply = (body) => send({ type: 'goal_reply', requestId: message.requestId, ...body })
  try {
    if (!api) throw new Error('Background agents are disabled.')
    const parsed = request.parse(message)
    const board = await api.board()
    const goal = board.goals.find((entry) => entry.id === parsed.goalId)
    if (!goal || !['active', 'paused'].includes(goal.status)) throw new Error('This goal is no longer active or paused. Refresh the board before retrying.')
    const info = `${parsed.info}\n\nUser follow-up: revise and retry blocked tasks where this information resolves the blocker. Keep the original scope and approval requirements; report any remaining blocker.`
    const result = await api.updateGoal(parsed.goalId, { info, ...(parsed.resume && { action: 'resume' }) })
    reply({ result: { id: result.id, status: result.status } })
  } catch (err) { reply({ error: String(err.message ?? err) }) }
  return true
}

export async function handleReportRequest(message, api, send) {
  if (message.type !== 'report_request') return false
  if (typeof message.requestId !== 'string' || !message.requestId || message.requestId.length > 100) return true
  const reply = (body) => send({ type: 'report_reply', requestId: message.requestId, ...body })
  try {
    if (!api) throw new Error('Background agents are disabled.')
    if (message.action === 'history') reply({ result: await api.board({ history: true }) })
    else {
      const parsed = z.object({ action: z.literal('task'), taskId: z.string().regex(/^t_[a-z0-9]+$/).max(100), file: z.string().min(1).max(1000).optional() }).parse(message)
      reply({ result: await api.taskReports(parsed.taskId, parsed.file) })
    }
  } catch (err) { reply({ error: String(err.message ?? err) }) }
  return true
}