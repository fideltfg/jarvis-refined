import { CronExpressionParser } from 'cron-parser'
import { z } from 'zod'

const instant = z.string().datetime({ offset: true })
const timezone = z.string().refine((value) => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true } catch { return false }
}, 'Use a valid IANA timezone, such as Europe/London.')
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm.')
export const triggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('once'), at: instant }).strict(),
  z.object({ type: z.literal('interval'), minutes: z.number().int().min(1).max(525600), startAt: instant.optional() }).strict(),
  z.object({ type: z.literal('daily'), time, timezone }).strict(),
  z.object({ type: z.literal('weekly'), time, timezone, days: z.array(z.number().int().min(0).max(6)).min(1).max(7) }).strict(),
])
export const scheduleSchema = z.object({
  title: z.string().trim().min(1).max(200),
  outcome: z.string().trim().min(1).max(10000),
  priority: z.number().int().min(1).max(5).default(3),
  trigger: triggerSchema,
}).strict()
export const scheduleChangesSchema = scheduleSchema.omit({ priority: true }).partial().extend({
  priority: z.number().int().min(1).max(5).optional(),
}).strict()

function localParts(date, zone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((part) => [part.type, part.value]))
}

export function nextRun(trigger, after, consumedAt = null) {
  const current = new Date(after)
  if (!Number.isFinite(current.getTime())) throw new Error('Invalid scheduling date.')
  if (trigger.type === 'once') return Date.parse(trigger.at) > +current ? new Date(trigger.at).toISOString() : null
  if (trigger.type === 'interval') {
    const anchor = Date.parse(trigger.startAt)
    const interval = trigger.minutes * 60000
    const count = Math.max(0, Math.floor((+current - anchor) / interval) + 1)
    return new Date(anchor + count * interval).toISOString()
  }
  const [hour, minute] = trigger.time.split(':').map(Number)
  const expression = `${minute} ${hour} * * ${trigger.type === 'weekly' ? trigger.days.join(',') : '*'}`
  const parser = CronExpressionParser.parse(expression, { currentDate: current, tz: trigger.timezone })
  const previous = localParts(current, trigger.timezone)
  const consumed = consumedAt ? localParts(new Date(consumedAt), trigger.timezone) : null
  for (let attempt = 0; attempt < 370; attempt++) {
    const candidate = parser.next().toDate()
    const parts = localParts(candidate, trigger.timezone)
    const sameDay = ['year', 'month', 'day'].every((key) => parts[key] === previous[key])
    if (consumed && ['year', 'month', 'day'].every((key) => parts[key] === consumed[key])) continue
    if (`${parts.hour}:${parts.minute}` !== trigger.time) continue
    if (sameDay && `${previous.hour}:${previous.minute}` >= trigger.time) continue
    return candidate.toISOString()
  }
  throw new Error('Could not determine the next calendar occurrence.')
}

export function scheduleInput(input, now) {
  const parsed = scheduleSchema.parse(input)
  const trigger = { ...parsed.trigger }
  if (trigger.type === 'interval') trigger.startAt ??= new Date(+new Date(now) + trigger.minutes * 60000).toISOString()
  if ((trigger.type === 'once' || trigger.type === 'interval') && Date.parse(trigger.at ?? trigger.startAt) <= +new Date(now)) {
    throw new Error('Choose a start time in the future.')
  }
  return { ...parsed, trigger, nextRunAt: nextRun(trigger, now) }
}