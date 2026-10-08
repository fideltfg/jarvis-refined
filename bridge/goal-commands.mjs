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

const goalDecision = z.object({
  goalId: z.string().regex(/^g_[a-z0-9]+$/).max(100),
  decision: z.enum(['approve', 'not_approve']),
  note: z.string().trim().max(2000).optional(),
})

export async function handleGoalDecisionRequest(message, api, send) {
  if (message.type !== 'goal_decision_request') return false
  if (typeof message.requestId !== 'string' || !message.requestId || message.requestId.length > 100) return true
  const reply = (body) => send({ type: 'goal_decision_reply', requestId: message.requestId, ...body })
  try {
    if (!api) throw new Error('Background agents are disabled.')
    const parsed = goalDecision.parse(message)
    const board = await api.board()
    const goal = board.goals.find((entry) => entry.id === parsed.goalId)
    if (goal?.status !== 'paused' || goal.awaitingResponse !== true) {
      throw new Error('This approval is no longer waiting. Refresh the board before responding.')
    }
    const info = parsed.decision === 'approve'
      ? `The user approved the proposed plan.${parsed.note ? `\n\nUser note: ${parsed.note}` : ''} Continue within the stated scope and existing approval requirements.`
      : `The user did not approve the proposed plan. Do not perform the proposed changes; keep this goal paused and prepare a revised plan for approval.${parsed.note ? `\n\nUser note: ${parsed.note}` : ''}`
    const result = await api.updateGoal(goal.id, { info, ...(parsed.decision === 'approve' && { action: 'resume' }) })
    reply({ result: { id: result.id, status: result.status } })
  } catch (err) { reply({ error: String(err.message ?? err) }) }
  return true
}

const decisionRequest = z.object({
  goalId: z.string().regex(/^g_[a-z0-9]+$/).max(100),
  taskId: z.string().regex(/^t_[a-z0-9]+$/).max(100),
  answers: z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,48}$/), z.string().regex(/^[a-zA-Z0-9_-]{1,48}$/))
    .refine((answers) => Object.keys(answers).length >= 1 && Object.keys(answers).length <= 5, 'Answer between one and five questions.'),
  note: z.string().trim().max(2000).optional(),
})

export async function handleDecisionRequest(message, api, send) {
  if (message.type !== 'decision_request') return false
  if (typeof message.requestId !== 'string' || !message.requestId || message.requestId.length > 100) return true
  const reply = (body) => send({ type: 'decision_reply', requestId: message.requestId, ...body })
  try {
    if (!api) throw new Error('Background agents are disabled.')
    const parsed = decisionRequest.parse(message)
    const board = await api.board()
    const goal = board.goals.find((entry) => entry.id === parsed.goalId)
    const task = goal?.tasks.find((entry) => entry.id === parsed.taskId)
    if (!goal || !['active', 'paused'].includes(goal.status) || task?.status !== 'blocked' || task.failure?.blocker !== 'decision') {
      throw new Error('This decision is no longer waiting. Refresh the board before retrying.')
    }
    const questions = task.failure.questions ?? []
    if (!questions.length || questions.length !== Object.keys(parsed.answers).length) throw new Error('Answer every current question before submitting.')
    const lines = questions.map((question) => {
      const option = question.options.find((entry) => entry.id === parsed.answers[question.id])
      if (!option) throw new Error('One selected option is no longer available. Refresh the board before retrying.')
      return `- ${question.prompt}: ${option.label}${option.detail ? ` (${option.detail})` : ''}`
    })
    if (Object.keys(parsed.answers).some((id) => !questions.some((question) => question.id === id))) throw new Error('One question is no longer available. Refresh the board before retrying.')
    const info = `The user answered the decision for "${task.title}":\n${lines.join('\n')}${parsed.note ? `\n\nAdditional note: ${parsed.note}` : ''}\n\nApply these choices within the original scope and approval requirements.`
    const result = await api.updateGoal(goal.id, { info, ...(goal.status === 'paused' && { action: 'resume' }) })
    reply({ result: { id: result.id, status: result.status } })
  } catch (err) { reply({ error: String(err.message ?? err) }) }
  return true
}

const goalControl = z.object({
  goalId: z.string().regex(/^g_[a-z0-9]+$/).max(100),
  action: z.enum(['pause', 'resume', 'abandon']),
})

export async function handleGoalControlRequest(message, api, send) {
  if (message.type !== 'goal_control_request') return false
  if (typeof message.requestId !== 'string' || !message.requestId || message.requestId.length > 100) return true
  const reply = (body) => send({ type: 'goal_control_reply', requestId: message.requestId, ...body })
  try {
    if (!api) throw new Error('Background agents are disabled.')
    const parsed = goalControl.parse(message)
    const board = await api.board()
    const goal = board.goals.find((entry) => entry.id === parsed.goalId)
    const allowed = parsed.action === 'pause' ? goal?.status === 'active'
      : parsed.action === 'resume' ? goal?.status === 'paused'
        : ['active', 'paused'].includes(goal?.status)
    if (!allowed) throw new Error('This goal can no longer be changed. Refresh the board before retrying.')
    const result = await api.updateGoal(goal.id, { action: parsed.action })
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
    else if (message.action === 'reference') {
      const parsed = z.object({ action: z.literal('reference'), taskId: z.string().regex(/^t_[a-z0-9]+$/).max(100), index: z.number().int().min(0).max(199) }).parse(message)
      reply({ result: await api.taskReference(parsed.taskId, parsed.index) })
    } else {
      const parsed = z.object({ action: z.literal('task'), taskId: z.string().regex(/^t_[a-z0-9]+$/).max(100), file: z.string().min(1).max(1000).optional() }).parse(message)
      reply({ result: await api.taskReports(parsed.taskId, parsed.file) })
    }
  } catch (err) { reply({ error: String(err.message ?? err) }) }
  return true
}