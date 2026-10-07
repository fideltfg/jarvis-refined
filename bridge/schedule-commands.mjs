import { z } from 'zod'
import { scheduleSchema, scheduleChangesSchema } from '../agents/schedules.mjs'

const identifier = z.string().regex(/^s_[a-z0-9]+$/).max(100)
const request = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }),
  z.object({ action: z.literal('create'), input: scheduleSchema }),
  z.object({ action: z.literal('update'), id: identifier, change: z.object({
    action: z.enum(['edit', 'pause', 'resume', 'delete']), values: scheduleChangesSchema.optional(),
  }).strict() }),
  z.object({ action: z.literal('run'), id: identifier }),
])

export async function handleScheduleRequest(message, api, send) {
  if (message.type !== 'schedule_request') return false
  if (typeof message.requestId !== 'string' || message.requestId.length > 100) return true
  const reply = (body) => send({ type: 'schedule_reply', requestId: message.requestId, ...body })
  try {
    if (!api) throw new Error('Background agents are disabled. Enable JARVIS_AGENTS and start the agent service to use schedules.')
    const parsed = request.parse(message)
    let result
    if (parsed.action === 'list') result = await api.schedules()
    else if (parsed.action === 'create') result = await api.createSchedule(parsed.input)
    else if (parsed.action === 'update') result = await api.updateSchedule(parsed.id, parsed.change)
    else result = await api.runSchedule(parsed.id)
    reply({ result })
  } catch (err) { reply({ error: String(err.message ?? err) }) }
  return true
}